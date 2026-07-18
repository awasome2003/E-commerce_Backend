/**
 * Delivery charge — the rules, with no database dependency.
 *
 * Kept pure and separate from `delivery.js` for the same reason as the pricing
 * engine: the rules are business decisions and must be testable on their own.
 *
 * Modes
 * -----
 *  FLAT        every order pays `flat_amount`
 *  FREE_ABOVE  free once the cart reaches `free_above_amount`, else `flat_amount`
 *  PER_ORDER   nothing at checkout; staff set the real charge on the order later
 *  PER_KM      `per_km_rate` x the outlet's `distance_km`
 *
 * PER_ORDER is the default because it is what the business actually did before
 * this feature existed: `orders.delivery_charge` holds hand-typed values (0, 1,
 * 20, 49, 79, 150, 250, 1700) that follow no rule and do not track cart size.
 *
 * PER_KM depends on a distance an admin types per outlet. There is no location
 * data in this schema — no lat/lng or pincode, and addresses are free text like
 * "Thane, Maharasthra" — so nothing can be geocoded.
 */

export const MODES = {
  FLAT: "FLAT",
  FREE_ABOVE: "FREE_ABOVE",
  PER_ORDER: "PER_ORDER",
  PER_KM: "PER_KM",
};

/** Round to paise. */
function toPaise(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * @param {object} settings  { mode, flat_amount, free_above_amount, per_km_rate } — plain numbers
 * @param {object} context   { cartTotal, distanceKm }  distanceKm may be null
 * @returns {{ amount:number, mode:string, reason:string, needs_admin:boolean }}
 */
export function resolveDelivery(settings, { cartTotal = 0, distanceKm = null } = {}) {
  const mode = settings?.mode ?? MODES.PER_ORDER;
  const flat = Number(settings?.flat_amount ?? 0);
  const freeAbove = Number(settings?.free_above_amount ?? 0);
  const rate = Number(settings?.per_km_rate ?? 0);

  switch (mode) {
    case MODES.FLAT:
      return {
        amount: toPaise(flat),
        mode,
        reason: `Flat delivery charge`,
        needs_admin: false,
      };

    case MODES.FREE_ABOVE:
      return cartTotal >= freeAbove
        ? {
            amount: 0,
            mode,
            reason: `Free delivery on orders over ${freeAbove}`,
            needs_admin: false,
          }
        : {
            amount: toPaise(flat),
            mode,
            reason: `Spend ${toPaise(freeAbove - cartTotal)} more for free delivery`,
            needs_admin: false,
          };

    case MODES.PER_KM:
      // A missing distance must not silently bill zero, and must not block the
      // customer either. Charge nothing now and flag it for staff — the same
      // outcome as PER_ORDER, but the reason says why.
      if (distanceKm === null || distanceKm === undefined) {
        return {
          amount: 0,
          mode,
          reason: "No distance recorded for this outlet — staff will confirm the delivery charge",
          needs_admin: true,
        };
      }
      return {
        amount: toPaise(rate * Number(distanceKm)),
        mode,
        reason: `${distanceKm} km at ${rate} per km`,
        needs_admin: false,
      };

    case MODES.PER_ORDER:
    default:
      return {
        amount: 0,
        mode: MODES.PER_ORDER,
        reason: "Delivery charge confirmed by staff after the order is placed",
        needs_admin: true,
      };
  }
}
