import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate, forUpdate, forSoftDelete } from "../lib/records.js";
import { resolvePrices } from "../lib/pricing.js";
import { quoteDelivery } from "../lib/delivery.js";
import { notifyCustomer } from "../lib/notify.js";

/**
 * The storefront API — everything a signed-in customer can do.
 *
 * Every price shown here comes from `resolvePrices`. Nothing in this file
 * re-derives a price: a customer must be quoted the same number the admin panel
 * previews for them.
 *
 * Guarded by the `Storefront` module in the permission matrix — the same matrix
 * that governs every admin module, so there are no role-title special cases.
 */

/** Attaches the resolved price to a list of products for this customer. */
async function priced(products, userId, quantity = 1) {
  const prices = await resolvePrices({
    productIds: products.map((p) => p.id),
    userId,
    quantity,
  });
  return products.map((p) => {
    const price = prices.get(p.id);
    return {
      ...p,
      unit_price: price?.unit_price ?? null,
      price_source: price?.source ?? null,
      // A product with no usable price is not for sale — see pricing-rules.js.
      purchasable: price?.unit_price !== null && price?.unit_price !== undefined,
    };
  });
}

// ---------------------------------------------------------------- catalogue

/**
 * Lookup lists for the storefront's filters.
 *
 * Separate from `/masters` on purpose: those are staff lists and include things a
 * customer has no business reading (roles, customer categories). Only categories
 * that actually have a sellable product are returned — 45 categories exist but
 * many are test junk with nothing in them.
 */
export async function listShopFilters(req, res, next) {
  try {
    const [categories, brands] = await Promise.all([
      prisma.master_category.findMany({
        where: { ...ACTIVE, products: { some: { ...ACTIVE, is_active: 1 } } },
        select: { id: true, title: true, image_url: true },
        orderBy: { title: "asc" },
      }),
      prisma.master_brands.findMany({
        where: { ...ACTIVE, products: { some: { ...ACTIVE, is_active: 1 } } },
        select: { id: true, title: true },
        orderBy: { title: "asc" },
      }),
    ]);
    res.json({ categories, brands });
  } catch (err) {
    next(err);
  }
}

export async function listShopProducts(req, res, next) {
  try {
    const { search = "", category_id, sub_category_id, brand_id, page = "1", limit = "24" } = req.query;

    const take = Math.min(Math.max(Number(limit) || 24, 1), 48);
    const currentPage = Math.max(Number(page) || 1, 1);

    const where = {
      ...ACTIVE,
      is_active: 1,
      ...(search
        ? { OR: [{ product_name: { contains: search } }, { item_number: { contains: search } }] }
        : {}),
      ...(category_id ? { category_id: Number(category_id) } : {}),
      ...(sub_category_id ? { sub_category_id: Number(sub_category_id) } : {}),
      ...(brand_id ? { brand_id: Number(brand_id) } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.products.findMany({
        where,
        select: {
          id: true,
          product_name: true,
          tax: true,
          moq: true,
          quantity_per_package: true,
          master_category: { select: { id: true, title: true } },
          master_brands: { select: { id: true, title: true } },
          product_images: {
            where: { ...ACTIVE, type: "slider_image" },
            select: { image_url: true },
            orderBy: { image_order: "asc" },
            take: 1,
          },
        },
        orderBy: { product_name: "asc" },
        take,
        skip: (currentPage - 1) * take,
      }),
      prisma.products.count({ where }),
    ]);

    res.json({
      items: await priced(rows, req.user.id),
      total,
      page: currentPage,
      limit: take,
      pages: Math.ceil(total / take),
    });
  } catch (err) {
    next(err);
  }
}

export async function getShopProduct(req, res, next) {
  try {
    const id = Number(req.params.id);
    const product = await prisma.products.findFirst({
      where: { id, ...ACTIVE, is_active: 1 },
      select: {
        id: true,
        product_name: true,
        product_description: true,
        tax: true,
        moq: true,
        hsn_code: true,
        quantity_per_package: true,
        master_category: { select: { id: true, title: true } },
        master_sub_category: { select: { id: true, title: true } },
        master_brands: { select: { id: true, title: true } },
        product_images: {
          where: ACTIVE,
          select: { id: true, image_url: true, type: true },
          orderBy: { image_order: "asc" },
        },
        product_ratings: {
          where: ACTIVE,
          select: { rating_value: true, feedback: true, created_at: true },
          orderBy: { created_at: "desc" },
          take: 5,
        },
      },
    });

    if (!product) return res.status(404).json({ message: "Product not found" });

    const userId = req.user.id;
    const [withPrice] = await priced([product], userId);

    // Bulk breaks are the whole point of this catalogue, so show what the price
    // becomes at each quantity this customer could reach — their own tiers as
    // well as the public ones.
    const tiers = await prisma.product_pricing.findMany({
      where: { product_id: id, ...ACTIVE },
      select: { quantity: true },
      orderBy: { quantity: "asc" },
    });
    const userTiers = await prisma.user_products_multipricing.findMany({
      where: { product_id: id, ...ACTIVE, user_id: userId },
      select: { quantity: true },
    });

    const breakpoints = [...new Set([1, ...tiers.map((t) => t.quantity), ...userTiers.map((t) => t.quantity)])]
      .filter((q) => q && q > 0)
      .sort((a, b) => a - b);

    const ladder = [];
    for (const qty of breakpoints) {
      const map = await resolvePrices({ productIds: [id], userId, quantity: qty });
      const r = map.get(id);
      ladder.push({ quantity: qty, unit_price: r?.unit_price ?? null, source: r?.source ?? null });
    }

    res.json({ ...withPrice, price_breaks: ladder });
  } catch (err) {
    next(err);
  }
}

// --------------------------------------------------------------------- cart

/**
 * The cart, always re-priced at read time.
 *
 * `cart.unitPrice`/`total_price` are stored snapshots, and in this database they
 * are unreliable — 14 of 47 rows have no unitPrice at all. They are refreshed on
 * every read so the customer is never shown a stale or missing price.
 */
export async function getCart(req, res, next) {
  try {
    const rows = await prisma.cart.findMany({
      where: { user_id: req.user.id, ...ACTIVE },
      select: {
        id: true,
        quantity: true,
        product_id: true,
        products: {
          select: {
            id: true,
            product_name: true,
            tax: true,
            moq: true,
            product_images: {
              where: { ...ACTIVE, type: "slider_image" },
              select: { image_url: true },
              orderBy: { image_order: "asc" },
              take: 1,
            },
          },
        },
      },
      orderBy: { created_at: "asc" },
    });

    if (rows.length === 0) return res.json({ items: [], cart_total: 0, tax_included: 0 });

    const quantities = new Map(rows.map((r) => [r.product_id, r.quantity]));
    const prices = await resolvePrices({
      productIds: rows.map((r) => r.product_id),
      userId: req.user.id,
      quantities,
    });

    const items = rows.map((row) => {
      const price = prices.get(row.product_id);
      return {
        id: row.id,
        quantity: row.quantity,
        product: row.products,
        unit_price: price?.unit_price ?? null,
        line_total: price?.line_total ?? null,
        price_source: price?.source ?? null,
        tax_included: price?.tax_included ?? null,
        purchasable: price?.unit_price !== null && price?.unit_price !== undefined,
      };
    });

    const cartTotal = items.reduce((sum, i) => sum + (i.line_total ?? 0), 0);
    const taxIncluded = items.reduce((sum, i) => sum + (i.tax_included ?? 0), 0);

    res.json({
      items,
      cart_total: Math.round(cartTotal * 100) / 100,
      tax_included: Math.round(taxIncluded * 100) / 100,
    });
  } catch (err) {
    next(err);
  }
}

export async function addToCart(req, res, next) {
  try {
    const { product_id, quantity = 1 } = req.body;
    if (!product_id) return res.status(400).json({ message: "product_id is required" });

    const qty = Math.max(Number(quantity) || 1, 1);

    const product = await prisma.products.findFirst({
      where: { id: Number(product_id), ...ACTIVE, is_active: 1 },
      select: { id: true, product_name: true },
    });
    if (!product) return res.status(404).json({ message: "Product not found" });

    // Refuse a product with no usable price for this customer, rather than let it
    // sit in the cart to be rejected only at checkout. The UI already hides the
    // button, so this is defence-in-depth against a direct/buggy client.
    const priced = await resolvePrices({ productIds: [product.id], userId: req.user.id, quantity: qty });
    if (!priced.get(product.id)?.unit_price) {
      return res.status(409).json({
        message: `${product.product_name} has no price and cannot be added to the cart.`,
      });
    }

    // `cart` has no unique constraint on (user_id, product_id), so upsert is not
    // available — find, then add to the existing line or create one.
    const existing = await prisma.cart.findFirst({
      where: { user_id: req.user.id, product_id: product.id, ...ACTIVE },
      select: { id: true, quantity: true },
    });

    if (existing) {
      await prisma.cart.update({
        where: { id: existing.id },
        data: forUpdate(req.user.id, { quantity: existing.quantity + qty }),
      });
    } else {
      await prisma.cart.create({
        data: forCreate(req.user.id, {
          user_id: req.user.id,
          product_id: product.id,
          quantity: qty,
        }),
      });
    }

    return getCart(req, res, next);
  } catch (err) {
    next(err);
  }
}

export async function updateCartItem(req, res, next) {
  try {
    const { quantity } = req.body;
    const qty = Number(quantity);
    if (!qty || qty < 1) return res.status(400).json({ message: "quantity must be at least 1" });

    // Scoped by user_id so one customer cannot edit another's cart line.
    const result = await prisma.cart.updateMany({
      where: { id: Number(req.params.id), user_id: req.user.id, ...ACTIVE },
      data: forUpdate(req.user.id, { quantity: qty }),
    });
    if (result.count === 0) return res.status(404).json({ message: "Cart item not found" });

    return getCart(req, res, next);
  } catch (err) {
    next(err);
  }
}

export async function removeCartItem(req, res, next) {
  try {
    const result = await prisma.cart.updateMany({
      where: { id: Number(req.params.id), user_id: req.user.id, ...ACTIVE },
      data: forSoftDelete(req.user.id),
    });
    if (result.count === 0) return res.status(404).json({ message: "Cart item not found" });

    return getCart(req, res, next);
  } catch (err) {
    next(err);
  }
}

// ------------------------------------------------------------------ outlets

export async function listMyOutlets(req, res, next) {
  try {
    const outlets = await prisma.user_outlets.findMany({
      where: { user_id: req.user.id, ...ACTIVE },
      select: {
        id: true,
        outlet_name: true,
        outlet_address: true,
        outlet_landmark: true,
        outlet_state: true,
        outlet_gstin: true,
        outlet_fssai: true,
        outlet_phones: {
          where: ACTIVE,
          select: { id: true, contact_person_name: true, phone_number: true },
        },
      },
      orderBy: { created_at: "asc" },
    });
    res.json(outlets);
  } catch (err) {
    next(err);
  }
}

/**
 * Creates an outlet, and its first contact.
 *
 * Only 27 of 54 customers have an outlet and just 12 have an outlet phone, yet
 * orders carry both `outlet_id` and `phone_id` — so without this, half the
 * customer base cannot check out at all.
 *
 * All the outlet text columns are NOT NULL with no default; empty strings are
 * written where the customer leaves an optional field blank, matching the
 * existing rows (several have an empty `outlet_state`).
 */
export async function createOutlet(req, res, next) {
  try {
    const {
      outlet_name,
      outlet_address,
      outlet_landmark = "",
      outlet_state = "",
      outlet_gstin = "",
      outlet_fssai = "",
      contact_person_name,
      phone_number,
    } = req.body;

    if (!outlet_name?.trim() || !outlet_address?.trim()) {
      return res.status(400).json({ message: "outlet_name and outlet_address are required" });
    }
    if (!contact_person_name?.trim() || !phone_number?.trim()) {
      return res.status(400).json({ message: "contact_person_name and phone_number are required" });
    }

    const outlet = await prisma.$transaction(async (tx) => {
      const created = await tx.user_outlets.create({
        data: forCreate(req.user.id, {
          user_id: req.user.id,
          outlet_name: outlet_name.trim(),
          outlet_address: outlet_address.trim(),
          outlet_landmark,
          outlet_state,
          outlet_gstin,
          outlet_fssai,
        }),
        select: { id: true },
      });

      await tx.outlet_phones.create({
        data: forCreate(req.user.id, {
          outlet_id: created.id,
          contact_person_name: contact_person_name.trim(),
          phone_number: phone_number.trim(),
        }),
      });

      return created;
    });

    res.status(201).json({ id: outlet.id });
  } catch (err) {
    next(err);
  }
}

// ----------------------------------------------------------------- checkout

/** What the customer would pay, without placing anything. */
export async function quoteCheckout(req, res, next) {
  try {
    const { outlet_id } = req.query;

    const rows = await prisma.cart.findMany({
      where: { user_id: req.user.id, ...ACTIVE },
      select: { product_id: true, quantity: true },
    });
    if (rows.length === 0) return res.status(400).json({ message: "Your cart is empty" });

    const quantities = new Map(rows.map((r) => [r.product_id, r.quantity]));
    const prices = await resolvePrices({
      productIds: rows.map((r) => r.product_id),
      userId: req.user.id,
      quantities,
    });

    const unpriceable = rows.filter((r) => !prices.get(r.product_id)?.unit_price);
    const cartTotal = rows.reduce(
      (sum, r) => sum + (prices.get(r.product_id)?.line_total ?? 0),
      0,
    );

    const delivery = await quoteDelivery({ cartTotal, outletId: outlet_id });

    res.json({
      cart_total: Math.round(cartTotal * 100) / 100,
      delivery: { amount: delivery.amount, reason: delivery.reason, needs_admin: delivery.needs_admin },
      total: Math.round((cartTotal + delivery.amount) * 100) / 100,
      unpriceable_products: unpriceable.map((r) => r.product_id),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Turns the cart into an order.
 *
 * Everything happens in one transaction: order, its lines, the notification, and
 * clearing the cart. A half-placed order is worse than a failed one.
 *
 * Prices are resolved server-side at this moment and written to
 * `order_products.unit_price` — the client's idea of the price is never trusted,
 * and the line keeps what was actually charged even if the catalogue changes later.
 */
export async function checkout(req, res, next) {
  try {
    const { outlet_id, phone_id } = req.body;
    if (!outlet_id) return res.status(400).json({ message: "outlet_id is required" });

    const outlet = await prisma.user_outlets.findFirst({
      where: { id: Number(outlet_id), user_id: req.user.id, ...ACTIVE },
      select: { id: true },
    });
    if (!outlet) return res.status(400).json({ message: "That outlet does not belong to you" });

    let phoneId = phone_id ? Number(phone_id) : null;
    if (phoneId) {
      const phone = await prisma.outlet_phones.findFirst({
        where: { id: phoneId, outlet_id: outlet.id, ...ACTIVE },
        select: { id: true },
      });
      if (!phone) return res.status(400).json({ message: "That contact does not belong to the outlet" });
    } else {
      const first = await prisma.outlet_phones.findFirst({
        where: { outlet_id: outlet.id, ...ACTIVE },
        select: { id: true },
      });
      phoneId = first?.id ?? null;
    }

    const rows = await prisma.cart.findMany({
      where: { user_id: req.user.id, ...ACTIVE },
      select: { id: true, product_id: true, quantity: true, products: { select: { product_name: true, tax: true } } },
    });
    if (rows.length === 0) return res.status(400).json({ message: "Your cart is empty" });

    const quantities = new Map(rows.map((r) => [r.product_id, r.quantity]));
    const prices = await resolvePrices({
      productIds: rows.map((r) => r.product_id),
      userId: req.user.id,
      quantities,
    });

    // Refuse rather than bill zero for something with no usable price.
    const unpriceable = rows.filter((r) => !prices.get(r.product_id)?.unit_price);
    if (unpriceable.length > 0) {
      return res.status(409).json({
        message: "Some items in your cart have no price and cannot be ordered",
        items: unpriceable.map((r) => ({ product_id: r.product_id, name: r.products.product_name })),
      });
    }

    const cartTotal = rows.reduce((sum, r) => sum + prices.get(r.product_id).line_total, 0);
    const delivery = await quoteDelivery({ cartTotal, outletId: outlet.id });
    const total = Math.round((cartTotal + delivery.amount) * 100) / 100;

    const user = await prisma.users.findFirst({
      where: { id: req.user.id, ...ACTIVE },
      select: { first_name: true, last_name: true, total_spent: true },
    });

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.orders.create({
        data: forCreate(req.user.id, {
          user_id: req.user.id,
          outlet_id: outlet.id,
          phone_id: phoneId,
          order_status: "Placed",
          cart_price: Math.round(cartTotal * 100) / 100,
          delivery_charge: delivery.amount,
          total_order_value: total,
          discount: 0,
          // Matches every existing order, where credits_used always equals
          // total_order_value: it records that the order went on the customer's
          // credit account, and never reduces the total.
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
        data: rows.map((r) => ({
          uuid: randomUUID(),
          created_by: req.user.id,
          order_id: created.id,
          product_id: r.product_id,
          quantity: r.quantity,
          unit_price: prices.get(r.product_id).unit_price,
          tax: r.products.tax ?? null,
        })),
      });

      // The legacy app writes one notification row per admin recipient; this
      // writes one message with one recipient row per admin, which is what the
      // schema intends. See notification.controller.js.
      const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
      const notification = await tx.notifications.create({
        data: forCreate(req.user.id, {
          title: `New Order Placed by ${name || `customer #${req.user.id}`}`,
          message: `Order #${created.id} for ${total} has been placed.`,
          order_id: created.id,
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
          data: admins.map((a) => ({
            uuid: randomUUID(),
            created_by: req.user.id,
            user_id: a.id,
            notification_id: notification.id,
            is_read: 0,
          })),
        });
      }

      // Confirm to the customer that their order landed.
      await notifyCustomer(tx, {
        actorId: req.user.id,
        userId: req.user.id,
        title: "Order placed",
        message: `Your order #${created.id} for ${total} has been placed.`,
        orderId: created.id,
      });

      await tx.users.update({
        where: { id: req.user.id },
        data: { total_spent: Number(user?.total_spent ?? 0) + total },
      });

      await tx.cart.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: forSoftDelete(req.user.id),
      });

      return created;
    });

    res.status(201).json({
      order_id: order.id,
      cart_total: Math.round(cartTotal * 100) / 100,
      delivery_charge: delivery.amount,
      total,
      delivery_note: delivery.needs_admin ? delivery.reason : null,
    });
  } catch (err) {
    next(err);
  }
}

// ------------------------------------------------------------------ orders

export async function listMyOrders(req, res, next) {
  try {
    const orders = await prisma.orders.findMany({
      where: { user_id: req.user.id, ...ACTIVE },
      select: {
        id: true,
        order_status: true,
        total_order_value: true,
        cart_price: true,
        delivery_charge: true,
        payment_recevied: true,
        created_at: true,
        user_outlets: { select: { outlet_name: true } },
        _count: { select: { order_products: true } },
      },
      orderBy: { created_at: "desc" },
    });
    res.json(orders);
  } catch (err) {
    next(err);
  }
}

export async function getMyOrder(req, res, next) {
  try {
    const order = await prisma.orders.findFirst({
      where: { id: Number(req.params.id), user_id: req.user.id, ...ACTIVE },
      select: {
        id: true,
        order_status: true,
        total_order_value: true,
        cart_price: true,
        delivery_charge: true,
        discount: true,
        payment_recevied: true,
        created_at: true,
        order_date: true,
        user_outlets: true,
        outlet_phones: { select: { contact_person_name: true, phone_number: true } },
        order_products: {
          where: ACTIVE,
          select: {
            id: true,
            quantity: true,
            unit_price: true,
            tax: true,
            products: { select: { id: true, product_name: true } },
          },
        },
        order_invoice: { where: ACTIVE, select: { invoice_number: true, invoice_url: true } },
      },
    });

    if (!order) return res.status(404).json({ message: "Order not found" });

    res.json({
      ...order,
      user_outlets: order.user_outlets
        ? {
            ...order.user_outlets,
            distance_km:
              order.user_outlets.distance_km === null ? null : Number(order.user_outlets.distance_km),
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
}
