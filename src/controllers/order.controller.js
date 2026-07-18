import { prisma } from "../lib/prisma.js";
import { ACTIVE, forUpdate } from "../lib/records.js";

/**
 * Client-side enum identifiers. Prisma sanitizes the hyphenated MySQL value
 * "Out-for-delivery" to `Out_for_delivery`; the database still stores the hyphen.
 */
export const ORDER_STATUSES = [
  "Placed",
  "Packed",
  "Dispatched",
  "Out_for_delivery",
  "Delivered",
];

export async function listOrders(req, res, next) {
  try {
    const { status, search = "", page = "1", limit = "25" } = req.query;

    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * take;

    const where = {
      ...ACTIVE,
      ...(status && ORDER_STATUSES.includes(status) ? { order_status: status } : {}),
      ...(search
        ? {
            OR: [
              { users: { first_name: { contains: search } } },
              { users: { last_name: { contains: search } } },
              { users: { email: { contains: search } } },
              { user_outlets: { outlet_name: { contains: search } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.orders.findMany({
        where,
        select: {
          id: true,
          order_status: true,
          total_order_value: true,
          cart_price: true,
          delivery_charge: true,
          discount: true,
          credits_used: true,
          payment_recevied: true,
          is_verified: true,
          order_date: true,
          created_at: true,
          users: { select: { id: true, first_name: true, last_name: true, email: true } },
          user_outlets: { select: { id: true, outlet_name: true, outlet_state: true } },
          _count: { select: { order_products: true } },
        },
        orderBy: { created_at: "desc" },
        take,
        skip,
      }),
      prisma.orders.count({ where }),
    ]);

    res.json({ items, total, page: currentPage, limit: take, pages: Math.ceil(total / take) });
  } catch (err) {
    next(err);
  }
}

export async function getOrder(req, res, next) {
  try {
    const order = await prisma.orders.findFirst({
      where: { id: Number(req.params.id), ...ACTIVE },
      include: {
        users: {
          select: {
            id: true, first_name: true, last_name: true, email: true,
            phone_number: true, gst_number: true, billing_name: true,
            billing_address: true, billing_state: true, credit_limit: true,
          },
        },
        user_outlets: true,
        outlet_phones: { select: { contact_person_name: true, phone_number: true } },
        order_products: {
          where: ACTIVE,
          select: {
            id: true, quantity: true, unit_price: true, tax: true,
            products: { select: { id: true, product_name: true, item_number: true, hsn_code: true } },
          },
        },
        order_invoice: {
          where: ACTIVE,
          select: { id: true, invoice_number: true, invoice_url: true, invoice_date: true, final_amount: true },
        },
        order_ratings: { where: ACTIVE, select: { rating_value: true, feedback: true } },
      },
    });

    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json(order);
  } catch (err) {
    next(err);
  }
}

export async function updateOrderStatus(req, res, next) {
  try {
    const { order_status } = req.body;
    if (!ORDER_STATUSES.includes(order_status)) {
      return res.status(400).json({
        message: `order_status must be one of: ${ORDER_STATUSES.join(", ")}`,
      });
    }

    const id = Number(req.params.id);
    const existing = await prisma.orders.findFirst({ where: { id, ...ACTIVE }, select: { id: true } });
    if (!existing) return res.status(404).json({ message: "Order not found" });

    const order = await prisma.orders.update({
      where: { id },
      data: forUpdate(req.user.id, { order_status }),
      select: { id: true, order_status: true },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
}

export async function updateOrderPayment(req, res, next) {
  try {
    const { payment_recevied } = req.body;
    if (payment_recevied === undefined) {
      return res.status(400).json({ message: "payment_recevied is required" });
    }

    const id = Number(req.params.id);
    const existing = await prisma.orders.findFirst({ where: { id, ...ACTIVE }, select: { id: true } });
    if (!existing) return res.status(404).json({ message: "Order not found" });

    const order = await prisma.orders.update({
      where: { id },
      data: forUpdate(req.user.id, { payment_recevied: payment_recevied ? 1 : 0 }),
      select: { id: true, payment_recevied: true },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
}
