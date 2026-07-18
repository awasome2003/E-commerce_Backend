import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { ACTIVE } from "../src/lib/records.js";
import { resolvePrices, toPaise, UnknownUserError } from "../src/lib/pricing.js";

/**
 * Replays every real cart and order line through the engine and compares the
 * result with what was actually charged.
 *
 * The engine is only trustworthy if it reproduces history. Every mismatch is
 * either a bug here or a rule we have not learned — neither should be ignored.
 *
 * Scope note: only lines on ACTIVE products are comparable. Historical order
 * lines point at soft-deleted, pre-migration products that were priced from the
 * old `product_price` column, so they cannot be replayed against `inst_price`.
 */

const TOLERANCE = 0.01; // money is float; never compare exactly

async function replay(label, lines) {
  const byUser = new Map();
  for (const line of lines) {
    if (!byUser.has(line.user_id)) byUser.set(line.user_id, []);
    byUser.get(line.user_id).push(line);
  }

  const rows = [];
  const unreplayable = [];

  for (const [userId, userLines] of byUser) {
    for (const line of userLines) {
      let result;
      try {
        const resolved = await resolvePrices({
          productIds: [line.product_id],
          userId,
          quantity: line.quantity,
        });
        result = resolved.get(line.product_id);
      } catch (err) {
        // The buyer has since been soft-deleted, so their pricing can no longer
        // be reconstructed. Report it rather than scoring it as a mismatch.
        if (err instanceof UnknownUserError) {
          // Still resolve anonymously so the line's charge can be eyeballed —
          // excluding it entirely would hide anomalies (e.g. a product with no
          // pricing rows that was nonetheless charged 3x its base).
          const anon = await resolvePrices({
            productIds: [line.product_id],
            quantity: line.quantity,
          });
          const base = anon.get(line.product_id);
          unreplayable.push({
            id: line.id,
            product: line.product_name,
            user_id: userId,
            quantity: line.quantity,
            charged: toPaise(line.charged),
            base_now: base?.unit_price ?? null,
          });
          continue;
        }
        throw err;
      }

      const expected = toPaise(line.charged);
      const actual = result?.unit_price ?? null;
      rows.push({
        id: line.id,
        product: line.product_name,
        user_id: userId,
        quantity: line.quantity,
        charged: expected,
        resolved: actual,
        source: result?.source ?? null,
        match: actual !== null && Math.abs(actual - expected) < TOLERANCE,
      });
    }
  }

  const matched = rows.filter((r) => r.match);
  const missed = rows.filter((r) => !r.match);

  console.log(`\n=== ${label} ===`);
  console.log(`lines replayed : ${rows.length}`);
  console.log(`reproduced     : ${matched.length}`);
  console.log(`mismatched     : ${missed.length}`);
  if (unreplayable.length) {
    console.log(`NOT REPLAYABLE : ${unreplayable.length} (buyer since soft-deleted)`);
    console.log(`  These are excluded from the score above — the score does NOT cover them.`);
    for (const u of unreplayable.slice(0, 8)) {
      // `base_now` is the anonymous price. A gap does not prove the charge was
      // wrong — the deleted buyer may have had an override we can no longer
      // apply — it only marks the line as worth a human look.
      const odd = u.base_now !== null && Math.abs(u.base_now - u.charged) > TOLERANCE;
      console.log(
        `   #${String(u.id).padEnd(4)} ${String(u.product).slice(0, 26).padEnd(26)} ` +
          `qty ${String(u.quantity).padEnd(3)} charged ${String(u.charged).padEnd(9)} ` +
          `base now ${String(u.base_now).padEnd(9)}${odd ? "  <-- differs from base; check by hand" : ""}`,
      );
    }
    if (unreplayable.length > 8) console.log(`   … and ${unreplayable.length - 8} more`);
  }

  const bySource = new Map();
  for (const r of matched) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  if (bySource.size) {
    console.log(
      "winning layer  : " +
        [...bySource].map(([s, n]) => `${s}=${n}`).join(", "),
    );
  }

  if (missed.length) {
    console.log("\n  mismatches (each is a bug or an unlearned rule):");
    for (const r of missed.slice(0, 15)) {
      console.log(
        `   #${String(r.id).padEnd(4)} ${String(r.product).slice(0, 28).padEnd(28)} ` +
          `qty ${String(r.quantity).padEnd(4)} charged ${String(r.charged).padEnd(9)} ` +
          `resolved ${String(r.resolved).padEnd(9)} via ${r.source}`,
      );
    }
    if (missed.length > 15) console.log(`   … and ${missed.length - 15} more`);
  }

  return { total: rows.length, matched: matched.length, missed, unreplayable };
}

// --- cart -------------------------------------------------------------------
const cartLines = await prisma.cart.findMany({
  where: { ...ACTIVE, unitPrice: { gt: 0 }, products: ACTIVE },
  select: {
    id: true,
    user_id: true,
    product_id: true,
    quantity: true,
    unitPrice: true,
    products: { select: { product_name: true } },
  },
});
const cart = await replay(
  "CART (live baskets)",
  cartLines.map((l) => ({
    id: l.id,
    user_id: l.user_id,
    product_id: l.product_id,
    quantity: l.quantity,
    charged: l.unitPrice,
    product_name: l.products.product_name,
  })),
);

// --- orders -----------------------------------------------------------------
const orderLines = await prisma.order_products.findMany({
  where: { ...ACTIVE, unit_price: { gt: 0 }, products: ACTIVE },
  select: {
    id: true,
    product_id: true,
    quantity: true,
    unit_price: true,
    orders: { select: { user_id: true } },
    products: { select: { product_name: true } },
  },
});
const orders = await replay(
  "ORDER LINES (active products only)",
  orderLines.map((l) => ({
    id: l.id,
    user_id: l.orders.user_id,
    product_id: l.product_id,
    quantity: l.quantity,
    charged: l.unit_price,
    product_name: l.products.product_name,
  })),
);

// --- coverage the backtest cannot give --------------------------------------
const [deletedProductLines, catCustomers] = await Promise.all([
  prisma.order_products.count({ where: { ...ACTIVE, products: { deleted_at: { not: null } } } }),
  prisma.users.count({ where: { ...ACTIVE, customer_category_id: { not: null } } }),
]);

console.log("\n=== coverage ===");
console.log(`order lines skipped (product soft-deleted, priced from the retired`);
console.log(`  product_price column — not comparable)          : ${deletedProductLines}`);
console.log(`customers with a category set                     : ${catCustomers}`);
console.log("  -> the category layers of the ladder are NOT exercised by history;");
console.log("     unit tests are the only cover for them.");

const totalMissed = cart.missed.length + orders.missed.length;
const totalScored = cart.total + orders.total;
const totalSkipped = cart.unreplayable.length + orders.unreplayable.length;

console.log("\n=== result ===");
console.log(`reproduced : ${cart.matched + orders.matched}/${totalScored} scored lines`);
console.log(`mismatched : ${totalMissed}`);
console.log(`excluded   : ${totalSkipped} lines (buyer deleted) + ${deletedProductLines} lines (product deleted)`);
console.log(
  "\nRead this honestly: the score covers live carts well and order history barely at all.\n" +
    "Most order lines are unscoreable — their buyer or product has since been deleted — so\n" +
    "a clean score here is NOT evidence the engine matches historical billing.",
);

await prisma.$disconnect();
process.exit(totalMissed > 0 ? 1 : 0);
