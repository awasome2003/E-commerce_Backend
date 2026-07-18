import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma.js";
import { ACTIVE, forCreate, forUpdate } from "../src/lib/records.js";

/**
 * Creates a throwaway Customer login for the storefront.
 *
 * The imported customers' real passwords are bcrypt hashes we cannot reverse, so
 * this adds a dedicated account rather than resetting a real person's.
 *
 * It is given the pricing overrides of customer 10 (a ₹5 flat price and a
 * "buy 5" tier on ZONE WATER MELON BAR SYRUP 750ML) so the storefront can be
 * exercised against a customer who actually has negotiated pricing — otherwise
 * every price would come from the base layer and the engine would go untested.
 */
const EMAIL = "dev.customer@local.test";
const PASSWORD = "customer123";

const role = await prisma.master_roles.findFirst({
  where: { title: "Customer", ...ACTIVE },
  select: { id: true },
});
if (!role) {
  console.error("No active 'Customer' role found.");
  process.exit(1);
}

const password = await bcrypt.hash(PASSWORD, 10);
const existing = await prisma.users.findFirst({ where: { email: EMAIL }, select: { id: true } });

let userId;
if (existing) {
  await prisma.users.update({
    where: { id: existing.id },
    data: forUpdate(null, { password, role_id: role.id, deleted_at: null }),
  });
  userId = existing.id;
  console.log(`Updated existing dev customer (id=${userId})`);
} else {
  const created = await prisma.users.create({
    data: forCreate(null, {
      first_name: "Dev",
      last_name: "Customer",
      email: EMAIL,
      user_name: "devcustomer",
      password,
      role_id: role.id,
      credit_limit: 100000,
      no_of_days: 30,
    }),
    select: { id: true },
  });
  userId = created.id;
  console.log(`Created dev customer (id=${userId})`);
}

// Copy customer 10's overrides so the pricing ladder is exercised end-to-end.
const SOURCE_USER = 10;
for (const [table, model] of [
  ["user_products", prisma.user_products],
  ["user_products_multipricing", prisma.user_products_multipricing],
]) {
  const rows = await model.findMany({ where: { user_id: SOURCE_USER, ...ACTIVE } });
  for (const row of rows) {
    const { id, uuid, created_at, updated_at, deleted_at, created_by, updated_by, ...rest } = row;
    const already = await model.findFirst({
      where: { user_id: userId, product_id: rest.product_id, ...ACTIVE },
      select: { id: true },
    });
    if (already) continue;
    await model.create({ data: forCreate(null, { ...rest, user_id: userId }) });
    console.log(`  copied ${table} row for product ${rest.product_id}`);
  }
}

const outlets = await prisma.user_outlets.count({ where: { user_id: userId, ...ACTIVE } });
console.log(`\nLogin: ${EMAIL} / ${PASSWORD}`);
console.log(`Outlets: ${outlets}${outlets === 0 ? " — create one in the storefront before checking out" : ""}`);

await prisma.$disconnect();
