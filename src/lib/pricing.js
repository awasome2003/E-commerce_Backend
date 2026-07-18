import { prisma } from "./prisma.js";
import { ACTIVE } from "./records.js";
import { resolveFromLayers, SOURCES, toPaise } from "./pricing-rules.js";

/**
 * Price resolution — the one place that decides what a customer pays.
 *
 * No controller may re-derive a price. Everything calls resolvePrice/resolvePrices.
 *
 * This module only fetches; the rules live in `pricing-rules.js`, which has no
 * database dependency so the ladder can be unit-tested directly.
 */

export { SOURCES, toPaise };

/**
 * Resolve prices for many products at once.
 *
 * Batched deliberately: a 30-line cart must not fire 120 queries. Four queries
 * cover every layer regardless of basket size.
 *
 * @param {object}   args
 * @param {number[]} args.productIds
 * @param {number}   [args.userId]      omit for anonymous/base pricing
 * @param {number}   [args.quantity=1]  applied to every product
 * @param {Map<number,number>} [args.quantities] per-product override of quantity
 * @returns {Promise<Map<number, object>>} productId -> result
 */
export class UnknownUserError extends Error {
  constructor(userId) {
    super(`No active user ${userId} — refusing to price silently as anonymous.`);
    this.name = "UnknownUserError";
    this.userId = userId;
  }
}

export async function resolvePrices({ productIds, userId, quantity = 1, quantities }) {
  const ids = [...new Set(productIds.map(Number))].filter((n) => Number.isInteger(n));
  if (ids.length === 0) return new Map();

  const qtyFor = (productId) => Math.max(Number(quantities?.get(productId) ?? quantity) || 1, 1);

  const user = userId
    ? await prisma.users.findFirst({
        where: { id: Number(userId), ...ACTIVE },
        select: { id: true, customer_category_id: true },
      })
    : null;

  // Passing a userId that resolves to nothing (deleted or bogus) must not quietly
  // degrade to base pricing: the caller asked for *that customer's* price and
  // would get a plausible wrong number with no signal. Omitting userId entirely
  // is the supported way to ask for anonymous pricing.
  if (userId && !user) throw new UnknownUserError(Number(userId));

  const categoryId = user?.customer_category_id ?? null;

  // A row addressed to a user and a row addressed to a category are different
  // layers, so both are fetched together and separated in memory below.
  const scopeOr = [
    ...(user ? [{ user_id: user.id }] : []),
    ...(categoryId ? [{ customer_category_id: categoryId }] : []),
  ];

  const [products, globalTiers, flatOverrides, tierOverrides] = await Promise.all([
    prisma.products.findMany({
      where: { id: { in: ids }, ...ACTIVE },
      select: { id: true, product_name: true, inst_price: true, tax: true, moq: true },
    }),
    prisma.product_pricing.findMany({
      where: { product_id: { in: ids }, ...ACTIVE },
      select: { id: true, product_id: true, quantity: true, price: true, label: true },
    }),
    scopeOr.length
      ? prisma.user_products.findMany({
          where: { product_id: { in: ids }, ...ACTIVE, OR: scopeOr },
          select: {
            id: true, product_id: true, item_price: true,
            user_id: true, customer_category_id: true,
          },
        })
      : [],
    scopeOr.length
      ? prisma.user_products_multipricing.findMany({
          where: { product_id: { in: ids }, ...ACTIVE, OR: scopeOr },
          select: {
            id: true, product_id: true, quantity: true, price: true, label: true,
            user_id: true, customer_category_id: true,
          },
        })
      : [],
  ]);

  const groupBy = (rows, pick) => {
    const map = new Map();
    for (const row of rows) {
      if (pick && !pick(row)) continue;
      if (!map.has(row.product_id)) map.set(row.product_id, []);
      map.get(row.product_id).push(row);
    }
    return map;
  };

  // A row belongs to the user layer only if it names the user; otherwise it is a
  // category row. Rows naming neither scope cannot be attributed and are ignored.
  const isUserRow = (r) => user !== null && r.user_id === user.id;
  const isCategoryRow = (r) =>
    categoryId !== null && r.user_id === null && r.customer_category_id === categoryId;

  const userFlat = groupBy(flatOverrides, isUserRow);
  const catFlat = groupBy(flatOverrides, isCategoryRow);
  const userTiers = groupBy(tierOverrides, isUserRow);
  const catTiers = groupBy(tierOverrides, isCategoryRow);
  const globals = groupBy(globalTiers);

  const results = new Map();
  for (const product of products) {
    const layers = {
      userTiers: userTiers.get(product.id) ?? [],
      userFlat: userFlat.get(product.id) ?? [],
      catTiers: catTiers.get(product.id) ?? [],
      catFlat: catFlat.get(product.id) ?? [],
      globalTiers: globals.get(product.id) ?? [],
    };
    results.set(product.id, resolveFromLayers(product, layers, qtyFor(product.id)));
  }

  return results;
}

/** Single-product convenience wrapper. */
export async function resolvePrice({ productId, userId, quantity = 1 }) {
  const map = await resolvePrices({ productIds: [productId], userId, quantity });
  return map.get(Number(productId)) ?? null;
}
