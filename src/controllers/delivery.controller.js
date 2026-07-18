import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate, forUpdate } from "../lib/records.js";
import { getDeliverySettings, MODES, quoteDelivery } from "../lib/delivery.js";

/**
 * Delivery configuration.
 *
 * One active row in `delivery_settings`. It is created by
 * `scripts/add-delivery-settings.js`, but this controller will create it on first
 * write so a fresh database cannot 404 here.
 */

export async function getSettings(req, res, next) {
  try {
    const settings = await getDeliverySettings();
    const outletsMissingDistance = await prisma.user_outlets.count({
      where: { ...ACTIVE, distance_km: null },
    });

    res.json({
      ...settings,
      modes: Object.values(MODES),
      // PER_KM is unusable until distances are filled in, so say so plainly
      // rather than letting an admin select it and quietly bill everyone zero.
      outlets_missing_distance: outletsMissingDistance,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateSettings(req, res, next) {
  try {
    const { mode, flat_amount, free_above_amount, per_km_rate } = req.body;

    if (mode && !Object.values(MODES).includes(mode)) {
      return res.status(400).json({
        message: `mode must be one of: ${Object.values(MODES).join(", ")}`,
      });
    }

    const amounts = { flat_amount, free_above_amount, per_km_rate };
    for (const [key, value] of Object.entries(amounts)) {
      if (value === undefined) continue;
      if (Number.isNaN(Number(value)) || Number(value) < 0) {
        return res.status(400).json({ message: `${key} must be a number of 0 or more` });
      }
    }

    const data = {
      ...(mode ? { mode } : {}),
      ...(flat_amount !== undefined ? { flat_amount: Number(flat_amount) } : {}),
      ...(free_above_amount !== undefined ? { free_above_amount: Number(free_above_amount) } : {}),
      ...(per_km_rate !== undefined ? { per_km_rate: Number(per_km_rate) } : {}),
    };

    const existing = await prisma.delivery_settings.findFirst({
      where: ACTIVE,
      orderBy: { id: "asc" },
      select: { id: true },
    });

    if (existing) {
      await prisma.delivery_settings.update({
        where: { id: existing.id },
        data: forUpdate(req.user.id, data),
      });
    } else {
      await prisma.delivery_settings.create({ data: forCreate(req.user.id, data) });
    }

    res.json(await getDeliverySettings());
  } catch (err) {
    next(err);
  }
}

/** Preview what a cart of a given size would be charged, for the settings screen. */
export async function previewDelivery(req, res, next) {
  try {
    const { cart_total, outlet_id } = req.query;
    res.json(
      await quoteDelivery({
        cartTotal: Number(cart_total) || 0,
        outletId: outlet_id ? Number(outlet_id) : null,
      }),
    );
  } catch (err) {
    next(err);
  }
}

/**
 * Sets an outlet's distance.
 *
 * There is no location data in this schema and outlet addresses are free text,
 * so PER_KM depends entirely on this being filled in by hand.
 */
export async function updateOutletDistance(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { distance_km } = req.body;

    if (distance_km !== null && distance_km !== "" && distance_km !== undefined) {
      if (Number.isNaN(Number(distance_km)) || Number(distance_km) < 0) {
        return res.status(400).json({ message: "distance_km must be a number of 0 or more, or null" });
      }
    }

    const outlet = await prisma.user_outlets.findFirst({
      where: { id, ...ACTIVE },
      select: { id: true },
    });
    if (!outlet) return res.status(404).json({ message: "Outlet not found" });

    // Empty means "unknown", which is not the same as 0 km — PER_KM must be able
    // to tell them apart.
    const value =
      distance_km === null || distance_km === "" || distance_km === undefined
        ? null
        : Number(distance_km);

    const updated = await prisma.user_outlets.update({
      where: { id },
      data: forUpdate(req.user.id, { distance_km: value }),
      select: { id: true, outlet_name: true, distance_km: true },
    });

    res.json({ ...updated, distance_km: updated.distance_km === null ? null : Number(updated.distance_km) });
  } catch (err) {
    next(err);
  }
}
