import { prisma } from "../lib/prisma.js";
import { ACTIVE, forUpdate } from "../lib/records.js";

/** Never select `password` or `otp` — they must not leave the database. */
const listSelect = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  phone_number: true,
  credit_limit: true,
  total_spent: true,
  no_of_days: true,
  created_at: true,
  master_customer_category: { select: { id: true, title: true } },
  master_roles: { select: { id: true, title: true } },
  _count: { select: { orders: true, user_outlets: true } },
};

/**
 * `users` holds staff and customers alike, separated only by role. Both "Customer"
 * roles (ids 5 and 6) share the same title, so match on the title rather than a
 * hardcoded id.
 */
const IS_CUSTOMER = { master_roles: { title: "Customer" } };

const WRITABLE = [
  "first_name",
  "last_name",
  "email",
  "phone_number",
  "credit_limit",
  "no_of_days",
  "customer_category_id",
  "billing_name",
  "billing_address",
  "billing_contact",
  "billing_state",
  "gst_number",
  "pan_number",
];

export async function listCustomers(req, res, next) {
  try {
    const { search = "", customer_category_id, page = "1", limit = "25" } = req.query;

    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * take;

    const where = {
      ...ACTIVE,
      ...IS_CUSTOMER,
      ...(search
        ? {
            OR: [
              { first_name: { contains: search } },
              { last_name: { contains: search } },
              { email: { contains: search } },
              { phone_number: { contains: search } },
            ],
          }
        : {}),
      ...(customer_category_id ? { customer_category_id: Number(customer_category_id) } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.users.findMany({ where, select: listSelect, orderBy: { created_at: "desc" }, take, skip }),
      prisma.users.count({ where }),
    ]);

    res.json({ items, total, page: currentPage, limit: take, pages: Math.ceil(total / take) });
  } catch (err) {
    next(err);
  }
}

export async function getCustomer(req, res, next) {
  try {
    const id = Number(req.params.id);

    const customer = await prisma.users.findFirst({
      where: { id, ...ACTIVE, ...IS_CUSTOMER },
      select: {
        ...listSelect,
        pan_number: true,
        gst_number: true,
        billing_name: true,
        billing_address: true,
        billing_contact: true,
        billing_state: true,
        user_outlets: {
          where: ACTIVE,
          select: {
            id: true, outlet_name: true, outlet_address: true, outlet_state: true,
            outlet_landmark: true, outlet_gstin: true, outlet_fssai: true,
            distance_km: true,
            outlet_phones: { where: ACTIVE, select: { contact_person_name: true, phone_number: true } },
          },
        },
      },
    });

    if (!customer) return res.status(404).json({ message: "Customer not found" });

    // distance_km is `decimal`, which Prisma returns as a Decimal object that
    // JSON-serialises to a string. Hand the client a number.
    res.json({
      ...customer,
      user_outlets: customer.user_outlets.map((o) => ({
        ...o,
        distance_km: o.distance_km === null ? null : Number(o.distance_km),
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * The negotiated prices that apply to one customer.
 *
 * Both override tables key off *either* `user_id` or `customer_category_id`, so
 * a customer inherits their category's pricing as well as any row addressed to
 * them personally. Rows are returned separately rather than merged; resolving
 * which one wins for a given quantity is the pricing engine's job.
 */
export async function getCustomerPricing(req, res, next) {
  try {
    const id = Number(req.params.id);

    const customer = await prisma.users.findFirst({
      where: { id, ...ACTIVE, ...IS_CUSTOMER },
      select: { id: true, customer_category_id: true },
    });
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const scope = {
      OR: [
        { user_id: id },
        ...(customer.customer_category_id
          ? [{ customer_category_id: customer.customer_category_id }]
          : []),
      ],
    };

    // inst_price is the live catalogue price an override is measured against.
    const productRef = {
      select: { id: true, product_name: true, item_number: true, inst_price: true },
    };

    const [flat, tiered] = await Promise.all([
      prisma.user_products.findMany({
        where: { ...ACTIVE, ...scope },
        select: {
          id: true, item_price: true, user_id: true, customer_category_id: true,
          products: productRef,
        },
      }),
      prisma.user_products_multipricing.findMany({
        where: { ...ACTIVE, ...scope },
        select: {
          id: true, quantity: true, price: true, label: true,
          user_id: true, customer_category_id: true,
          products: productRef,
        },
        orderBy: { quantity: "asc" },
      }),
    ]);

    res.json({
      customer_category_id: customer.customer_category_id,
      flat_overrides: flat,
      tiered_overrides: tiered,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateCustomer(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.users.findFirst({
      where: { id, ...ACTIVE, ...IS_CUSTOMER },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ message: "Customer not found" });

    const data = {};
    for (const key of WRITABLE) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }

    const customer = await prisma.users.update({
      where: { id },
      data: forUpdate(req.user.id, data),
      select: listSelect,
    });
    res.json(customer);
  } catch (err) {
    next(err);
  }
}
