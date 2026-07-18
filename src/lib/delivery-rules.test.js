import test from "node:test";
import assert from "node:assert/strict";
import { resolveDelivery, MODES } from "./delivery-rules.js";

const FLAT = { mode: MODES.FLAT, flat_amount: 250, free_above_amount: 0, per_km_rate: 0 };
const FREE = { mode: MODES.FREE_ABOVE, flat_amount: 250, free_above_amount: 5000, per_km_rate: 0 };
const PERKM = { mode: MODES.PER_KM, flat_amount: 0, free_above_amount: 0, per_km_rate: 12.5 };
const PERORDER = { mode: MODES.PER_ORDER, flat_amount: 0, free_above_amount: 0, per_km_rate: 0 };

test("FLAT charges the same regardless of cart size", () => {
  assert.equal(resolveDelivery(FLAT, { cartTotal: 100 }).amount, 250);
  assert.equal(resolveDelivery(FLAT, { cartTotal: 999999 }).amount, 250);
});

test("FREE_ABOVE is free at or above the threshold", () => {
  assert.equal(resolveDelivery(FREE, { cartTotal: 5000 }).amount, 0, "inclusive at the threshold");
  assert.equal(resolveDelivery(FREE, { cartTotal: 5001 }).amount, 0);
});

test("FREE_ABOVE charges the flat rate below the threshold, and says how far off", () => {
  const r = resolveDelivery(FREE, { cartTotal: 4000 });
  assert.equal(r.amount, 250);
  assert.match(r.reason, /1000/, "tells the customer what is left to spend");
});

test("PER_KM multiplies rate by distance", () => {
  const r = resolveDelivery(PERKM, { cartTotal: 100, distanceKm: 8 });
  assert.equal(r.amount, 100); // 12.5 * 8
  assert.equal(r.needs_admin, false);
});

test("PER_KM rounds to paise", () => {
  assert.equal(resolveDelivery(PERKM, { cartTotal: 0, distanceKm: 3.3 }).amount, 41.25);
});

test("PER_KM with no recorded distance charges nothing and flags staff", () => {
  // Must not silently bill 0 as if it were a real answer, and must not block the
  // customer either — 56 of 56 outlets currently have no distance.
  const r = resolveDelivery(PERKM, { cartTotal: 100, distanceKm: null });
  assert.equal(r.amount, 0);
  assert.equal(r.needs_admin, true);
  assert.match(r.reason, /distance/i);
});

test("PER_KM treats zero distance as a real answer, not a missing one", () => {
  const r = resolveDelivery(PERKM, { cartTotal: 100, distanceKm: 0 });
  assert.equal(r.amount, 0);
  assert.equal(r.needs_admin, false, "0 km is known; null is unknown");
});

test("PER_ORDER charges nothing and flags staff", () => {
  const r = resolveDelivery(PERORDER, { cartTotal: 9999 });
  assert.equal(r.amount, 0);
  assert.equal(r.needs_admin, true);
});

test("an unknown or missing mode falls back to PER_ORDER, never to a guess", () => {
  assert.equal(resolveDelivery({ mode: "NONSENSE" }, { cartTotal: 500 }).mode, MODES.PER_ORDER);
  assert.equal(resolveDelivery(undefined, { cartTotal: 500 }).mode, MODES.PER_ORDER);
  assert.equal(resolveDelivery({}, {}).amount, 0);
});
