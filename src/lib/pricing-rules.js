/**
 * Price resolution — the rules, with no database dependency.
 *
 * This module is deliberately pure: given a product and its price layers, it
 * decides what a customer pays. `pricing.js` fetches the layers and calls in
 * here. Keeping the two apart is what lets the ladder be tested without a
 * database, which matters because history cannot validate most of it.
 *
 * ---------------------------------------------------------------------------
 * The rules, and where they come from
 * ---------------------------------------------------------------------------
 *
 * The four price tables form a grid: {everyone, one customer} x {flat, bulk}.
 * Most specific wins.
 *
 *   1 USER_TIER      user_products_multipricing (user_id)              qty >= tier
 *   2 USER_FLAT      user_products (user_id)                           always
 *   3 CATEGORY_TIER  user_products_multipricing (customer_category_id) qty >= tier
 *   4 CATEGORY_FLAT  user_products (customer_category_id)              always
 *   5 GLOBAL_TIER    product_pricing                                   qty >= tier
 *   6 BASE           products.inst_price                               fallback
 *
 * MOST SPECIFIC WINS — NOT CHEAPEST. Client-confirmed with a worked example: a
 * customer priced at ₹50 who buys 30 pays ₹50, even though the public bulk tier
 * would give ₹9. Do not "help" by picking the minimum; it would look kind and be
 * wrong.
 *
 * Proven from real transactions (see PLAN.md):
 *  - Tier `price` is PER UNIT, not a bundle total. Cart 677: 38 x 9 = 342.
 *  - Tier `quantity` is a LOWER THRESHOLD, inclusive. Cart 677: tiers at 20 (₹10)
 *    and 25 (₹9), ordered 38, charged ₹9. Cart 730: tier at 30, ordered 30,
 *    charged ₹250.
 *  - `label` is free text and LIES about the maths — "buy 5 get at 5000" is
 *    stored as quantity 5, price 1000. Never parse it.
 *
 * Stated, not proven: rows 1-4 have never competed in a real order (only 3 of 54
 * customers even have a category), so history cannot validate them. The unit
 * tests are the only thing standing behind them.
 *
 * Tiers are NOT monotonic in this data (qty 30 -> ₹250 but qty 50 -> ₹450), so
 * selection is strictly by quantity threshold and never by comparing prices.
 *
 * `products.product_price` is not a layer: it is 0 across the whole active
 * catalogue. `inst_price` is the price.
 *
 * Money is MySQL `float` throughout, so prices are rounded to paise on the way
 * out and never compared with ===.
 */

export const SOURCES = {
  USER_TIER: "user_tier",
  USER_FLAT: "user_flat",
  CATEGORY_TIER: "category_tier",
  CATEGORY_FLAT: "category_flat",
  GLOBAL_TIER: "global_tier",
  BASE: "base",
};

/** Money is float; round to paise before returning or comparing. */
export function toPaise(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * A price row only counts if it carries a usable amount.
 *
 * 4 tier rows and 12 active products sit at 0, and it is unknown whether that
 * means "free" or "never filled in". Skipping is the safe reading: resolving to
 * ₹0 would give stock away silently. Flip this once the client rules on it.
 */
export function usable(price) {
  return price !== null && price !== undefined && Number(price) > 0;
}

/** Highest tier whose quantity <= ordered quantity. Threshold, never price. */
export function bestTier(rows, quantity) {
  let winner = null;
  for (const row of rows) {
    if (row.quantity === null || row.quantity === undefined) continue;
    if (row.quantity > quantity) continue;
    if (!usable(row.price)) continue;
    if (!winner || row.quantity > winner.quantity) winner = row;
  }
  return winner;
}

function candidate(source, row, price, applies, note) {
  return {
    source,
    row_id: row?.id ?? null,
    price: price === null || price === undefined ? null : toPaise(price),
    applies,
    note,
  };
}

/**
 * Decide the price for one product.
 *
 * @param {object} product  { id, product_name, inst_price, tax, moq }
 * @param {object} layers   { userTiers, userFlat, catTiers, catFlat, globalTiers } — arrays
 * @param {number} quantity
 */
export function resolveFromLayers(product, layers, quantity) {
  const qty = Math.max(Number(quantity) || 1, 1);
  const candidates = [];

  const ladder = [
    { source: SOURCES.USER_TIER, row: bestTier(layers.userTiers ?? [], qty), priceOf: (r) => r.price },
    {
      source: SOURCES.USER_FLAT,
      row: (layers.userFlat ?? []).find((r) => usable(r.item_price)) ?? null,
      priceOf: (r) => r.item_price,
    },
    { source: SOURCES.CATEGORY_TIER, row: bestTier(layers.catTiers ?? [], qty), priceOf: (r) => r.price },
    {
      source: SOURCES.CATEGORY_FLAT,
      row: (layers.catFlat ?? []).find((r) => usable(r.item_price)) ?? null,
      priceOf: (r) => r.item_price,
    },
    { source: SOURCES.GLOBAL_TIER, row: bestTier(layers.globalTiers ?? [], qty), priceOf: (r) => r.price },
  ];

  let winner = null;
  for (const step of ladder) {
    if (!step.row) continue;
    const price = step.priceOf(step.row);
    const applies = usable(price);
    candidates.push(candidate(step.source, step.row, price, applies && !winner, step.row.label ?? null));
    if (applies && !winner) winner = { source: step.source, row: step.row, price };
  }

  const baseApplies = usable(product.inst_price);
  candidates.push(candidate(SOURCES.BASE, null, product.inst_price, baseApplies && !winner, null));
  if (!winner && baseApplies) winner = { source: SOURCES.BASE, row: null, price: product.inst_price };

  return {
    product_id: product.id,
    product_name: product.product_name,
    quantity: qty,
    // null means no layer had a usable price — including the base. Callers must
    // treat that as "not for sale", never as free.
    unit_price: winner ? toPaise(winner.price) : null,
    line_total: winner ? toPaise(winner.price * qty) : null,
    source: winner?.source ?? null,
    matched_row_id: winner?.row?.id ?? null,
    tax_percent: product.tax ?? null,
    // Prices are tax-inclusive, so this is the tax already inside unit_price —
    // not something to add on top. See PLAN.md.
    tax_included:
      winner && product.tax
        ? toPaise(winner.price * qty * (product.tax / (100 + product.tax)))
        : null,
    moq: product.moq ?? null,
    candidates,
  };
}
