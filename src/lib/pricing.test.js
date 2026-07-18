import test from "node:test";
import assert from "node:assert/strict";
// Imports the pure rules, not `pricing.js` — the ladder must be testable without
// a database, since history cannot validate most of it.
import { resolveFromLayers, SOURCES, toPaise } from "./pricing-rules.js";

/**
 * The ladder cannot be validated against history — the user and category scopes
 * have never competed in a real order (only 3 of 54 customers have a category,
 * and none of them appear in the override evidence). These tests are the only
 * thing standing behind rows 1-4, so they encode the client's stated rules
 * directly.
 *
 * Run with: npm test
 */

const PRODUCT = { id: 1, product_name: "Sauce 500g", inst_price: 100, tax: null, moq: null };
const NONE = { userTiers: [], userFlat: [], catTiers: [], catFlat: [], globalTiers: [] };

const tier = (id, quantity, price, label = null) => ({ id, quantity, price, label });
const flat = (id, item_price) => ({ id, item_price });

test("falls back to the base price when nothing else applies", () => {
  const r = resolveFromLayers(PRODUCT, NONE, 1);
  assert.equal(r.unit_price, 100);
  assert.equal(r.source, SOURCES.BASE);
  assert.equal(r.line_total, 100);
});

test("line total is unit price x quantity (tier price is per unit, not a bundle)", () => {
  // Cart 677 in the real data: 38 x 9 = 342.
  const r = resolveFromLayers(PRODUCT, { ...NONE, globalTiers: [tier(1, 25, 9)] }, 38);
  assert.equal(r.unit_price, 9);
  assert.equal(r.line_total, 342);
});

test("picks the highest tier at or below the ordered quantity", () => {
  // Real product 3513: tiers at 20 -> 10 and 25 -> 9; ordered 38, charged 9.
  const layers = { ...NONE, globalTiers: [tier(1, 20, 10), tier(2, 25, 9)] };
  assert.equal(resolveFromLayers(PRODUCT, layers, 38).unit_price, 9);
  assert.equal(resolveFromLayers(PRODUCT, layers, 24).unit_price, 10);
});

test("a tier applies exactly at its threshold", () => {
  // Cart 730: tier at 30, ordered 30, charged 250.
  const r = resolveFromLayers(PRODUCT, { ...NONE, globalTiers: [tier(1, 30, 250)] }, 30);
  assert.equal(r.unit_price, 250);
  assert.equal(r.source, SOURCES.GLOBAL_TIER);
});

test("quantity below every tier falls back to base", () => {
  const r = resolveFromLayers(PRODUCT, { ...NONE, globalTiers: [tier(1, 25, 9)] }, 24);
  assert.equal(r.unit_price, 100);
  assert.equal(r.source, SOURCES.BASE);
});

test("MOST SPECIFIC WINS, NOT CHEAPEST: a customer's flat price beats a cheaper public tier", () => {
  // The client's worked example: priced at 50, buys 30, public tier says 9.
  const layers = { ...NONE, userFlat: [flat(7, 50)], globalTiers: [tier(1, 25, 9)] };
  const r = resolveFromLayers(PRODUCT, layers, 30);
  assert.equal(r.unit_price, 50, "must pay their own price, not the cheaper public tier");
  assert.equal(r.source, SOURCES.USER_FLAT);
});

test("most specific wins even when the customer's price is HIGHER than public", () => {
  const layers = { ...NONE, userFlat: [flat(7, 150)], globalTiers: [tier(1, 5, 20)] };
  const r = resolveFromLayers(PRODUCT, layers, 10);
  assert.equal(r.unit_price, 150);
  assert.equal(r.source, SOURCES.USER_FLAT);
});

test("the customer's own tier beats the customer's own flat price", () => {
  const layers = { ...NONE, userTiers: [tier(3, 5, 40)], userFlat: [flat(7, 50)] };
  const r = resolveFromLayers(PRODUCT, layers, 10);
  assert.equal(r.unit_price, 40);
  assert.equal(r.source, SOURCES.USER_TIER);
});

test("the customer's own tier is ignored below its threshold, falling to their flat price", () => {
  const layers = { ...NONE, userTiers: [tier(3, 20, 40)], userFlat: [flat(7, 50)] };
  const r = resolveFromLayers(PRODUCT, layers, 10);
  assert.equal(r.unit_price, 50);
  assert.equal(r.source, SOURCES.USER_FLAT);
});

test("user scope beats category scope", () => {
  const layers = { ...NONE, userFlat: [flat(7, 50)], catFlat: [flat(9, 30)] };
  const r = resolveFromLayers(PRODUCT, layers, 1);
  assert.equal(r.unit_price, 50);
  assert.equal(r.source, SOURCES.USER_FLAT);
});

test("category scope beats the public tier", () => {
  const layers = { ...NONE, catFlat: [flat(9, 30)], globalTiers: [tier(1, 1, 20)] };
  const r = resolveFromLayers(PRODUCT, layers, 5);
  assert.equal(r.unit_price, 30);
  assert.equal(r.source, SOURCES.CATEGORY_FLAT);
});

test("full ladder order is honoured when every layer matches", () => {
  const layers = {
    userTiers: [tier(1, 2, 11)],
    userFlat: [flat(2, 22)],
    catTiers: [tier(3, 2, 33)],
    catFlat: [flat(4, 44)],
    globalTiers: [tier(5, 2, 55)],
  };
  assert.equal(resolveFromLayers(PRODUCT, layers, 5).source, SOURCES.USER_TIER);
  assert.equal(resolveFromLayers(PRODUCT, { ...layers, userTiers: [] }, 5).source, SOURCES.USER_FLAT);
  assert.equal(
    resolveFromLayers(PRODUCT, { ...layers, userTiers: [], userFlat: [] }, 5).source,
    SOURCES.CATEGORY_TIER,
  );
  assert.equal(
    resolveFromLayers(PRODUCT, { ...layers, userTiers: [], userFlat: [], catTiers: [] }, 5).source,
    SOURCES.CATEGORY_FLAT,
  );
  assert.equal(
    resolveFromLayers(PRODUCT, { ...layers, userTiers: [], userFlat: [], catTiers: [], catFlat: [] }, 5).source,
    SOURCES.GLOBAL_TIER,
  );
});

test("zero-priced rows are skipped, not treated as free", () => {
  // 4 tier rows and 12 products sit at 0 and it is unknown whether that means
  // free or unfilled. Skipping is the safe reading.
  const layers = { ...NONE, userTiers: [tier(1, 1, 0)], globalTiers: [tier(2, 1, 0)] };
  const r = resolveFromLayers(PRODUCT, layers, 5);
  assert.equal(r.unit_price, 100);
  assert.equal(r.source, SOURCES.BASE);
});

test("a product with no usable price anywhere resolves to null, never 0", () => {
  const r = resolveFromLayers({ ...PRODUCT, inst_price: 0 }, NONE, 1);
  assert.equal(r.unit_price, null);
  assert.equal(r.source, null);
  assert.equal(r.line_total, null);
});

test("non-monotonic tiers are selected by threshold, never by price", () => {
  // Real data really does this: qty 30 -> 250 but qty 50 -> 450.
  const layers = { ...NONE, globalTiers: [tier(1, 30, 250), tier(2, 50, 450)] };
  const r = resolveFromLayers(PRODUCT, layers, 60);
  assert.equal(r.unit_price, 450, "must take the highest matching threshold, not the cheapest row");
});

test("labels are display-only and never parsed", () => {
  // "buy 5 get at 5000" is stored as quantity 5, price 1000 — the label lies.
  const layers = { ...NONE, globalTiers: [tier(1, 5, 1000, "buy 5 get at 5000")] };
  const r = resolveFromLayers(PRODUCT, layers, 5);
  assert.equal(r.unit_price, 1000);
  assert.equal(r.line_total, 5000);
});

test("candidates expose every matching layer and mark the winner", () => {
  const layers = { ...NONE, userFlat: [flat(7, 50)], globalTiers: [tier(1, 5, 9)] };
  const r = resolveFromLayers(PRODUCT, layers, 10);

  const applied = r.candidates.filter((c) => c.applies);
  assert.equal(applied.length, 1, "exactly one candidate may win");
  assert.equal(applied[0].source, SOURCES.USER_FLAT);

  const losing = r.candidates.find((c) => c.source === SOURCES.GLOBAL_TIER);
  assert.equal(losing.applies, false);
  assert.equal(losing.price, 9, "losing candidates keep their price for the preview screen");
});

test("tax is reported as already included, not added on top", () => {
  // Prices are tax-inclusive: 105 at 5% contains 5 of tax.
  const r = resolveFromLayers({ ...PRODUCT, inst_price: 105, tax: 5 }, NONE, 1);
  assert.equal(r.unit_price, 105);
  assert.equal(r.tax_included, 5);
});

test("float storage is rounded to paise on the way out", () => {
  // MySQL float: 194.46 reads back as 194.4600067138672.
  assert.equal(toPaise(194.4600067138672), 194.46);
  const r = resolveFromLayers({ ...PRODUCT, inst_price: 194.4600067138672 }, NONE, 3);
  assert.equal(r.unit_price, 194.46);
  assert.equal(r.line_total, 583.38);
});

test("quantity is coerced to at least 1", () => {
  assert.equal(resolveFromLayers(PRODUCT, NONE, 0).quantity, 1);
  assert.equal(resolveFromLayers(PRODUCT, NONE, -5).quantity, 1);
});
