import { prisma } from "./prisma.js";
import { ACTIVE } from "./records.js";
import { resolveDelivery, MODES } from "./delivery-rules.js";

export { MODES, resolveDelivery };

/**
 * Reads the single delivery configuration row.
 *
 * The table holds exactly one active row. If it is missing (fresh database, or
 * the seed never ran) fall back to PER_ORDER — the pre-existing behaviour, where
 * staff set each charge by hand. Inventing a charge would be worse than none.
 *
 * `decimal` columns come back as Prisma `Decimal` objects, which JSON-serialise
 * to strings; convert to numbers here so nothing downstream has to know.
 */
export async function getDeliverySettings() {
  const row = await prisma.delivery_settings.findFirst({
    where: ACTIVE,
    orderBy: { id: "asc" },
  });

  if (!row) {
    return { mode: MODES.PER_ORDER, flat_amount: 0, free_above_amount: 0, per_km_rate: 0 };
  }

  return {
    id: row.id,
    mode: row.mode,
    flat_amount: Number(row.flat_amount),
    free_above_amount: Number(row.free_above_amount),
    per_km_rate: Number(row.per_km_rate),
  };
}

/** Delivery charge for a cart going to a given outlet. */
export async function quoteDelivery({ cartTotal, outletId }) {
  const settings = await getDeliverySettings();

  let distanceKm = null;
  if (settings.mode === MODES.PER_KM && outletId) {
    const outlet = await prisma.user_outlets.findFirst({
      where: { id: Number(outletId), ...ACTIVE },
      select: { distance_km: true },
    });
    distanceKm = outlet?.distance_km === null || outlet?.distance_km === undefined
      ? null
      : Number(outlet.distance_km);
  }

  return { ...resolveDelivery(settings, { cartTotal, distanceKm }), settings };
}
