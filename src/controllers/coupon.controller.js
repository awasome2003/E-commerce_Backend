import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate, forUpdate, forSoftDelete } from "../lib/records.js";

/**
 * Coupons are not wired to anything.
 *
 * Nothing in the schema references `product_coupons` — there is no `coupon_id`
 * on orders, cart or order_products, and `orders.discount` is a bare float with
 * no provenance. So a coupon can be managed here but cannot actually be redeemed;
 * redemption needs a schema change. This module is deliberately CRUD-only.
 *
 * PROVISIONAL, pending client confirmation: `discount` is a percentage and
 * `price` is a flat rupee amount. The two are mutually exclusive in the data (2
 * rows set discount, 5 set price, none set both). Both readings live in
 * `couponValue`/`applyCouponData` below — change them here, nowhere else.
 */

export const DISCOUNT_TYPES = { PERCENT: "percent", FLAT: "flat" };

/** Reads a stored row into { type, value }. */
export function couponValue(row) {
  if (row.discount !== null && row.discount !== undefined) {
    return { type: DISCOUNT_TYPES.PERCENT, value: row.discount };
  }
  if (row.price !== null && row.price !== undefined) {
    return { type: DISCOUNT_TYPES.FLAT, value: row.price };
  }
  return { type: null, value: null };
}

/** Writes { discount_type, value } back to the two columns, clearing the other. */
function applyCouponData(body) {
  if (body.discount_type === undefined && body.value === undefined) return {};

  const value = body.value === "" || body.value === null ? null : Number(body.value);
  if (body.discount_type === DISCOUNT_TYPES.PERCENT) return { discount: value, price: null };
  if (body.discount_type === DISCOUNT_TYPES.FLAT) return { discount: null, price: value };
  return { discount: null, price: null };
}

function present(row) {
  const { discount, price, ...rest } = row;
  return { ...rest, ...couponValue({ discount, price }) };
}

/**
 * `product_coupons.code` has no unique index and the data already contains two
 * rows coded `TEST`. Enforce uniqueness here so we stop making it worse.
 */
async function codeTaken(code, excludeId) {
  const clash = await prisma.product_coupons.findFirst({
    where: {
      code,
      ...ACTIVE,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return Boolean(clash);
}

export async function listCoupons(req, res, next) {
  try {
    const { search = "", is_active } = req.query;

    const rows = await prisma.product_coupons.findMany({
      where: {
        ...ACTIVE,
        ...(search
          ? { OR: [{ code: { contains: search } }, { title: { contains: search } }] }
          : {}),
        ...(is_active !== undefined && is_active !== "" ? { is_active: Number(is_active) } : {}),
      },
      orderBy: { created_at: "desc" },
    });

    // Surface duplicate codes rather than hiding them — they already exist.
    const counts = new Map();
    for (const r of rows) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);

    res.json(rows.map((r) => ({ ...present(r), duplicate_code: counts.get(r.code) > 1 })));
  } catch (err) {
    next(err);
  }
}

export async function getCoupon(req, res, next) {
  try {
    const row = await prisma.product_coupons.findFirst({
      where: { id: Number(req.params.id), ...ACTIVE },
    });
    if (!row) return res.status(404).json({ message: "Coupon not found" });
    res.json(present(row));
  } catch (err) {
    next(err);
  }
}

export async function createCoupon(req, res, next) {
  try {
    const { code, title, description, is_active } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ message: "code is required" });

    if (await codeTaken(code.trim())) {
      return res.status(409).json({ message: `Coupon code '${code.trim()}' is already in use` });
    }

    const row = await prisma.product_coupons.create({
      data: forCreate(req.user.id, {
        code: code.trim(),
        title: title ?? null,
        description: description ?? null,
        is_active: is_active === undefined ? 1 : Number(is_active),
        ...applyCouponData(req.body),
      }),
    });
    res.status(201).json(present(row));
  } catch (err) {
    next(err);
  }
}

export async function updateCoupon(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.product_coupons.findFirst({
      where: { id, ...ACTIVE },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ message: "Coupon not found" });

    const { code, title, description, is_active } = req.body;
    if (code !== undefined && (await codeTaken(code.trim(), id))) {
      return res.status(409).json({ message: `Coupon code '${code.trim()}' is already in use` });
    }

    const row = await prisma.product_coupons.update({
      where: { id },
      data: forUpdate(req.user.id, {
        ...(code !== undefined ? { code: code.trim() } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(is_active !== undefined ? { is_active: Number(is_active) } : {}),
        ...applyCouponData(req.body),
      }),
    });
    res.json(present(row));
  } catch (err) {
    next(err);
  }
}

export async function deleteCoupon(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.product_coupons.findFirst({
      where: { id, ...ACTIVE },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ message: "Coupon not found" });

    await prisma.product_coupons.update({ where: { id }, data: forSoftDelete(req.user.id) });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
