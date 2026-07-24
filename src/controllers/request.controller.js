import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate, forUpdate, forSoftDelete } from "../lib/records.js";
import { resolvePrices } from "../lib/pricing.js";
import { quoteDelivery } from "../lib/delivery.js";
import { notifyCustomer } from "../lib/notify.js";

/**
 * Product and order requests.
 *
 * A customer raises a request for things the cart cannot express: an item the
 * catalogue does not carry, or a basket they want priced before committing.
 * Staff quote it, then approve — and approval CONVERTS the request into a real
 * order at the quoted prices, so the number the customer agreed to is the number
 * they are billed.
 *
 * Status flow. Each transition is guarded; nothing moves backwards:
 *
 *   Pending ──quote──> Quoted ──approve──> Approved   (order created)
 *      │                  │
 *      └──────reject──────┴────────────────> Rejected
 *
 * Two rules worth stating, because both protect real money:
 *
 *  1. Approval requires every line to name a CATALOGUE product. A line for
 *     something we do not stock has no product_id to put on an order line, so the
 *     admin must create the product first. Refusing is the only honest option —
 *     the alternative is dropping lines from an order the customer thinks is
 *     complete.
 *  2. A line's price comes from `quoted_price` if set, otherwise from the pricing
 *     engine for that customer. It is never re-derived after approval, and the
 *     conversion runs in a transaction so a request can never be marked Approved
 *     without its order existing.
 */

export const STATUS = {
  PENDING: "Pending",
  QUOTED: "Quoted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

/** Lines join their product so the admin sees what is actually being asked for. */
const itemSelect = {
  id: true,
  product_id: true,
  product_name: true,
  quantity: true,
  quoted_price: true,
  products: {
    select: { id: true, product_name: true, item_number: true, inst_price: true },
  },
};

const requestSelect = {
  id: true,
  status: true,
  note: true,
  admin_reply: true,
  order_id: true,
  outlet_id: true,
  user_id: true,
  created_at: true,
  users: { select: { id: true, first_name: true, last_name: true, email: true } },
  user_outlets: { select: { id: true, outlet_name: true } },
  product_request_items: { where: ACTIVE, select: itemSelect, orderBy: { id: "asc" } },
};

/** decimal(10,2) arrives as a Prisma Decimal; JSON needs a number. */
function present(row) {
  return {
    ...row,
    product_request_items: row.product_request_items?.map((item) => ({
      ...item,
      quoted_price: item.quoted_price === null ? null : Number(item.quoted_price),
    })),
  };
}

/**
 * Validates the incoming lines.
 *
 * Mirrors the CHECK constraint on the table: a line must name a catalogue
 * product or a free-text one. Doing it here as well means the customer gets a
 * useful message instead of a driver error.
 */
function readItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: "A request needs at least one item" };
  }

  const items = [];
  for (const [index, raw] of rawItems.entries()) {
    const productId = raw.product_id ? Number(raw.product_id) : null;
    const name = typeof raw.product_name === "string" ? raw.product_name.trim() : "";
    const quantity = Number(raw.quantity);

    if (!productId && !name) {
      return { error: `Item ${index + 1}: choose a product or type a name` };
    }
    if (!Number.isFinite(quantity) || quantity < 1) {
      return { error: `Item ${index + 1}: quantity must be at least 1` };
    }

    items.push({
      product_id: productId,
      // A named catalogue product does not need the free-text copy, and keeping
      // both would let them disagree once the product is renamed.
      product_name: productId ? null : name,
      quantity: Math.floor(quantity),
    });
  }
  return { items };
}

// --- customer side -----------------------------------------------------------

export async function createMyRequest(req, res, next) {
  try {
    const { note, outlet_id, items: rawItems } = req.body;

    const { items, error } = readItems(rawItems);
    if (error) return res.status(400).json({ message: error });

    let outletId = null;
    if (outlet_id) {
      const outlet = await prisma.user_outlets.findFirst({
        where: { id: Number(outlet_id), user_id: req.user.id, ...ACTIVE },
        select: { id: true },
      });
      if (!outlet) return res.status(400).json({ message: "That outlet does not belong to you" });
      outletId = outlet.id;
    }

    // Catalogue products must exist and be active, or approval would later fail
    // on a line the customer was told was fine.
    const productIds = items.map((i) => i.product_id).filter(Boolean);
    if (productIds.length > 0) {
      const found = await prisma.products.findMany({
        where: { id: { in: productIds }, ...ACTIVE },
        select: { id: true },
      });
      const known = new Set(found.map((p) => p.id));
      const missing = productIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        return res.status(400).json({ message: `Unknown product(s): ${missing.join(", ")}` });
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const request = await tx.product_requests.create({
        data: forCreate(req.user.id, {
          user_id: req.user.id,
          outlet_id: outletId,
          status: STATUS.PENDING,
          note: note?.trim() || null,
        }),
        select: { id: true },
      });

      await tx.product_request_items.createMany({
        data: items.map((item) => ({
          uuid: randomUUID(),
          created_by: req.user.id,
          request_id: request.id,
          ...item,
        })),
      });

      // Same pattern as checkout: one message, one recipient row per admin.
      const notification = await tx.notifications.create({
        data: forCreate(req.user.id, {
          title: "New product request",
          message: `Request #${request.id} with ${items.length} item(s) needs review.`,
          is_admin: 1,
        }),
        select: { id: true },
      });

      const admins = await tx.users.findMany({
        where: { ...ACTIVE, master_roles: { title: "Admin", ...ACTIVE } },
        select: { id: true },
      });

      if (admins.length > 0) {
        await tx.notification_user.createMany({
          data: admins.map((admin) => ({
            uuid: randomUUID(),
            created_by: req.user.id,
            user_id: admin.id,
            notification_id: notification.id,
            is_read: 0,
          })),
        });
      }

      return request;
    });

    const full = await prisma.product_requests.findFirst({
      where: { id: created.id },
      select: requestSelect,
    });
    res.status(201).json(present(full));
  } catch (err) {
    next(err);
  }
}

export async function listMyRequests(req, res, next) {
  try {
    const rows = await prisma.product_requests.findMany({
      where: { user_id: req.user.id, ...ACTIVE },
      select: requestSelect,
      orderBy: { created_at: "desc" },
    });
    res.json(rows.map(present));
  } catch (err) {
    next(err);
  }
}

export async function getMyRequest(req, res, next) {
  try {
    // Scoped to the signed-in customer, so one customer can never read another's.
    const row = await prisma.product_requests.findFirst({
      where: { id: Number(req.params.id), user_id: req.user.id, ...ACTIVE },
      select: requestSelect,
    });
    if (!row) return res.status(404).json({ message: "Request not found" });
    res.json(present(row));
  } catch (err) {
    next(err);
  }
}

/** A customer may withdraw a request until it has been converted. */
export async function cancelMyRequest(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.product_requests.findFirst({
      where: { id, user_id: req.user.id, ...ACTIVE },
      select: { id: true, status: true },
    });
    if (!existing) return res.status(404).json({ message: "Request not found" });
    if (existing.status === STATUS.APPROVED) {
      return res.status(409).json({
        message: "This request has already become an order and cannot be withdrawn",
      });
    }

    await prisma.product_requests.update({ where: { id }, data: forSoftDelete(req.user.id) });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// --- staff side --------------------------------------------------------------

export async function listRequests(req, res, next) {
  try {
    const { status, search = "" } = req.query;

    const rows = await prisma.product_requests.findMany({
      where: {
        ...ACTIVE,
        ...(status ? { status } : {}),
        ...(search
          ? {
              users: {
                OR: [
                  { first_name: { contains: search } },
                  { last_name: { contains: search } },
                  { email: { contains: search } },
                ],
              },
            }
          : {}),
      },
      select: requestSelect,
      orderBy: { created_at: "desc" },
    });
    res.json(rows.map(present));
  } catch (err) {
    next(err);
  }
}

export async function getRequest(req, res, next) {
  try {
    const row = await prisma.product_requests.findFirst({
      where: { id: Number(req.params.id), ...ACTIVE },
      select: requestSelect,
    });
    if (!row) return res.status(404).json({ message: "Request not found" });
    res.json(present(row));
  } catch (err) {
    next(err);
  }
}

/**
 * Quote a request: set a per-unit price on some or all lines, and optionally
 * reply. Moves Pending -> Quoted.
 */
export async function quoteRequest(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { admin_reply, items: rawItems } = req.body;

    const existing = await prisma.product_requests.findFirst({
      where: { id, ...ACTIVE },
      select: {
        id: true,
        status: true,
        user_id: true,
        product_request_items: { where: ACTIVE, select: { id: true } },
      },
    });
    if (!existing) return res.status(404).json({ message: "Request not found" });
    if (existing.status === STATUS.APPROVED || existing.status === STATUS.REJECTED) {
      return res.status(409).json({ message: `A ${existing.status.toLowerCase()} request cannot be re-quoted` });
    }

    const ownIds = new Set(existing.product_request_items.map((i) => i.id));
    const updates = [];
    const linkIds = [];

    for (const raw of rawItems ?? []) {
      const itemId = Number(raw.id);
      // Guards against pricing a line that belongs to a different request.
      if (!ownIds.has(itemId)) {
        return res.status(400).json({ message: `Item ${itemId} is not part of this request` });
      }

      const price = raw.quoted_price === "" || raw.quoted_price === null ? null : Number(raw.quoted_price);
      if (price !== null && (!Number.isFinite(price) || price < 0)) {
        return res.status(400).json({ message: `Item ${itemId}: price must be zero or more` });
      }

      // product_id is optional: absent/blank leaves the line untouched, while a
      // real id links a free-text line to the catalogue so it can go on an order.
      let productId;
      if (raw.product_id !== undefined && raw.product_id !== null && raw.product_id !== "") {
        productId = Number(raw.product_id);
        if (!Number.isInteger(productId) || productId <= 0) {
          return res.status(400).json({ message: `Item ${itemId}: invalid product` });
        }
        linkIds.push(productId);
      }
      updates.push({ id: itemId, quoted_price: price, productId });
    }

    // Validate every requested link exists before writing anything.
    if (linkIds.length > 0) {
      const found = await prisma.products.findMany({
        where: { id: { in: linkIds } },
        select: { id: true },
      });
      const ok = new Set(found.map((p) => p.id));
      const missing = linkIds.find((pid) => !ok.has(pid));
      if (missing) return res.status(400).json({ message: `Product #${missing} is not in the catalogue` });
    }

    await prisma.$transaction(async (tx) => {
      for (const update of updates) {
        // Linking sets product_id and clears the free-text name — the line now
        // points at a real product, which the table's CHECK constraint accepts
        // as a catalogue line.
        const data = { quoted_price: update.quoted_price };
        if (update.productId) {
          data.product_id = update.productId;
          data.product_name = null;
        }
        await tx.product_request_items.update({
          where: { id: update.id },
          data: forUpdate(req.user.id, data),
        });
      }

      await tx.product_requests.update({
        where: { id },
        data: forUpdate(req.user.id, {
          status: STATUS.QUOTED,
          ...(admin_reply !== undefined ? { admin_reply: admin_reply?.trim() || null } : {}),
        }),
      });

      // Let the customer know their request has been priced.
      await notifyCustomer(tx, {
        actorId: req.user.id,
        userId: existing.user_id,
        title: "Request quoted",
        message: `We've quoted a price for your request #${id}. Review it in your requests.`,
      });
    });

    const row = await prisma.product_requests.findFirst({ where: { id }, select: requestSelect });
    res.json(present(row));
  } catch (err) {
    next(err);
  }
}

export async function rejectRequest(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.product_requests.findFirst({
      where: { id, ...ACTIVE },
      select: { id: true, status: true, user_id: true },
    });
    if (!existing) return res.status(404).json({ message: "Request not found" });
    if (existing.status === STATUS.APPROVED) {
      return res.status(409).json({ message: "This request has already become an order" });
    }

    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.product_requests.update({
        where: { id },
        data: forUpdate(req.user.id, {
          status: STATUS.REJECTED,
          ...(req.body.admin_reply !== undefined
            ? { admin_reply: req.body.admin_reply?.trim() || null }
            : {}),
        }),
        select: requestSelect,
      });

      if (existing.user_id) {
        await notifyCustomer(tx, {
          actorId: req.user.id,
          userId: existing.user_id,
          title: "Request declined",
          message: `Your request #${id} was declined. Contact us if you have questions.`,
        });
      }
      return updated;
    });
    res.json(present(row));
  } catch (err) {
    next(err);
  }
}

/**
 * Approve a request and convert it into an order.
 *
 * Mirrors `checkout` in shop.controller.js — same order columns, same delivery
 * quote, same notification shape — so an order born from a request is
 * indistinguishable from one placed through the cart.
 */
export async function approveRequest(req, res, next) {
  try {
    const id = Number(req.params.id);

    const request = await prisma.product_requests.findFirst({
      where: { id, ...ACTIVE },
      select: {
        id: true,
        status: true,
        user_id: true,
        outlet_id: true,
        order_id: true,
        product_request_items: {
          where: ACTIVE,
          select: { id: true, product_id: true, product_name: true, quantity: true, quoted_price: true },
        },
      },
    });
    if (!request) return res.status(404).json({ message: "Request not found" });

    if (request.status === STATUS.APPROVED) {
      return res.status(409).json({
        message: `Already approved as order #${request.order_id}`,
        order_id: request.order_id,
      });
    }
    if (request.status === STATUS.REJECTED) {
      return res.status(409).json({ message: "A rejected request cannot be approved" });
    }

    // An order line needs a product_id. Refuse rather than silently drop lines.
    const unstocked = request.product_request_items.filter((i) => !i.product_id);
    if (unstocked.length > 0) {
      return res.status(409).json({
        message:
          "Some items are not in the catalogue. Create them as products first, then approve.",
        items: unstocked.map((i) => ({ id: i.id, product_name: i.product_name })),
      });
    }

    const outletId = req.body.outlet_id ? Number(req.body.outlet_id) : request.outlet_id;
    if (!outletId) {
      return res.status(400).json({ message: "An outlet is required before this can become an order" });
    }
    const outlet = await prisma.user_outlets.findFirst({
      where: { id: outletId, user_id: request.user_id, ...ACTIVE },
      select: { id: true },
    });
    if (!outlet) {
      return res.status(400).json({ message: "That outlet does not belong to this customer" });
    }

    // Unquoted lines fall back to what this customer would pay anyway, so a
    // request can be approved without pricing every line by hand.
    const quantities = new Map(request.product_request_items.map((i) => [i.product_id, i.quantity]));
    const resolved = await resolvePrices({
      productIds: request.product_request_items.map((i) => i.product_id),
      userId: request.user_id,
      quantities,
    });

    const lines = [];
    for (const item of request.product_request_items) {
      const quoted = item.quoted_price === null ? null : Number(item.quoted_price);
      const unitPrice = quoted ?? resolved.get(item.product_id)?.unit_price ?? null;
      if (unitPrice === null) {
        return res.status(409).json({
          message: "Some items have no quoted price and no catalogue price. Quote them first.",
          items: [{ id: item.id, product_id: item.product_id }],
        });
      }
      lines.push({ ...item, unit_price: unitPrice });
    }

    const products = await prisma.products.findMany({
      where: { id: { in: lines.map((l) => l.product_id) } },
      select: { id: true, tax: true },
    });
    const taxOf = new Map(products.map((p) => [p.id, p.tax]));

    const cartTotal = lines.reduce((sum, l) => sum + l.unit_price * l.quantity, 0);
    const delivery = await quoteDelivery({ cartTotal, outletId: outlet.id });
    const total = Math.round((cartTotal + delivery.amount) * 100) / 100;

    const phone = await prisma.outlet_phones.findFirst({
      where: { outlet_id: outlet.id, ...ACTIVE },
      select: { id: true },
    });

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.orders.create({
        data: forCreate(req.user.id, {
          user_id: request.user_id,
          outlet_id: outlet.id,
          phone_id: phone?.id ?? null,
          order_status: "Placed",
          cart_price: Math.round(cartTotal * 100) / 100,
          delivery_charge: delivery.amount,
          total_order_value: total,
          discount: 0,
          credits_used: total,
          tax_deducted: 0,
          order_date: new Date(),
          payment_recevied: 0,
          is_verified: 0,
          attempts: 0,
        }),
        select: { id: true },
      });

      await tx.order_products.createMany({
        data: lines.map((l) => ({
          uuid: randomUUID(),
          created_by: req.user.id,
          order_id: created.id,
          product_id: l.product_id,
          quantity: l.quantity,
          unit_price: l.unit_price,
          tax: taxOf.get(l.product_id) ?? null,
        })),
      });

      await tx.product_requests.update({
        where: { id: request.id },
        data: forUpdate(req.user.id, {
          status: STATUS.APPROVED,
          order_id: created.id,
          outlet_id: outlet.id,
          ...(req.body.admin_reply !== undefined
            ? { admin_reply: req.body.admin_reply?.trim() || null }
            : {}),
        }),
      });

      // Tell the customer, not the admins — this notification runs the other way
      // round from the one raised when the request was created.
      const notification = await tx.notifications.create({
        data: forCreate(req.user.id, {
          title: "Your request was approved",
          message: `Request #${request.id} is now order #${created.id} for ${total}.`,
          order_id: created.id,
          is_admin: 0,
        }),
        select: { id: true },
      });

      await tx.notification_user.create({
        data: {
          uuid: randomUUID(),
          created_by: req.user.id,
          user_id: request.user_id,
          notification_id: notification.id,
          is_read: 0,
        },
      });

      return created;
    });

    const row = await prisma.product_requests.findFirst({ where: { id }, select: requestSelect });
    res.json({ ...present(row), order_id: order.id });
  } catch (err) {
    next(err);
  }
}
