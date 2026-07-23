import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate, forUpdate, forSoftDelete } from "../lib/records.js";

/**
 * Writing the price layers.
 *
 * Until now every layer below the catalogue price was read-only: negotiated
 * prices and quantity tiers could only be created by hand in SQL. This is the
 * write side of the ladder described in `lib/pricing-rules.js`:
 *
 *   user_products                 flat price for one customer
 *   user_products_multipricing    quantity tier for one customer
 *   product_pricing               quantity tier for everyone
 *
 * Three rules are enforced here rather than left to the database, because in
 * each case the engine's behaviour would otherwise be silently wrong:
 *
 *  1. A price of zero is REFUSED. `usable()` skips rows priced at or below zero,
 *     so a ₹0 row looks saved but never applies. Refusing is better than
 *     accepting a row that does nothing. (If the client later rules that ₹0 means
 *     "free", this check and `usable()` change together.)
 *
 *  2. No duplicate flat row per (customer, product), and no duplicate tier at the
 *     same quantity. The ladder takes the FIRST usable flat row and the HIGHEST
 *     qualifying tier, so a duplicate is either dead weight or a coin toss.
 *
 *  3. Category-scoped rows cannot be edited through a customer's page. Those rows
 *     belong to every customer in the category, and editing one from a single
 *     customer's screen would quietly reprice everybody else.
 */

/** Money is float in these legacy columns; round to paise on the way in. */
function toPaise(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Validates a price. Returns an error message, or null when acceptable.
 *
 * See rule 1 above — zero is a refusal, not a default.
 */
function priceError(value, field = "price") {
  if (value === undefined || value === null || value === "") return `${field} is required`;
  const number = Number(value);
  if (!Number.isFinite(number)) return `${field} must be a number`;
  if (number <= 0) {
    return `${field} must be greater than zero — a zero price is ignored by the pricing engine, so the row would never apply`;
  }
  return null;
}

function quantityError(value) {
  if (value === undefined || value === null || value === "") return "quantity is required";
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return "quantity must be a whole number of 1 or more";
  return null;
}

/** Confirms the customer exists, is a customer, and is active. */
async function findCustomer(id) {
  return prisma.users.findFirst({
    where: { id: Number(id), ...ACTIVE, master_roles: { title: "Customer" } },
    select: { id: true },
  });
}

async function findProduct(id) {
  return prisma.products.findFirst({
    where: { id: Number(id), ...ACTIVE },
    select: { id: true, product_name: true },
  });
}

/**
 * Loads a row and confirms it belongs to this customer personally.
 *
 * Rule 3: a row carrying `customer_category_id` with no `user_id` is a category
 * row shared by everyone in that category, and must not be edited from one
 * customer's screen.
 */
async function ownRow(model, rowId, userId) {
  const row = await model.findFirst({
    where: { id: Number(rowId), ...ACTIVE },
    select: { id: true, user_id: true, customer_category_id: true, product_id: true },
  });
  if (!row) return { error: { status: 404, message: "Price row not found" } };

  // A category row names no user. Say so precisely — the two refusals below mean
  // different things, and reporting one as the other sends the admin looking in
  // the wrong place.
  if (row.user_id === null && row.customer_category_id !== null) {
    return {
      error: {
        status: 409,
        message:
          "This price comes from the customer's category and is shared with other customers. Edit it under the category, not here.",
      },
    };
  }

  if (row.user_id !== Number(userId)) {
    // 404 rather than 403: whether another customer has a negotiated price is
    // not something this request should be able to probe.
    return { error: { status: 404, message: "Price row not found for this customer" } };
  }

  return { row };
}

function fail(res, error) {
  return res.status(error.status).json({ message: error.message });
}

// --- customer flat prices (user_products) ------------------------------------

export async function createCustomerFlatPrice(req, res, next) {
  try {
    const customer = await findCustomer(req.params.id);
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const { product_id, item_price } = req.body;
    const invalid = priceError(item_price, "item_price");
    if (invalid) return res.status(400).json({ message: invalid });

    const product = await findProduct(product_id);
    if (!product) return res.status(400).json({ message: "Unknown product" });

    // Rule 2: the ladder takes the first usable flat row, so a second one for the
    // same product would never be reachable.
    const clash = await prisma.user_products.findFirst({
      where: { user_id: customer.id, product_id: product.id, ...ACTIVE },
      select: { id: true },
    });
    if (clash) {
      return res.status(409).json({
        message: `${product.product_name} already has a fixed price for this customer. Edit that one instead.`,
        id: clash.id,
      });
    }

    const row = await prisma.user_products.create({
      data: forCreate(req.user.id, {
        user_id: customer.id,
        product_id: product.id,
        item_price: toPaise(item_price),
      }),
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

export async function updateCustomerFlatPrice(req, res, next) {
  try {
    const { error } = await ownRow(prisma.user_products, req.params.rowId, req.params.id);
    if (error) return fail(res, error);

    const invalid = priceError(req.body.item_price, "item_price");
    if (invalid) return res.status(400).json({ message: invalid });

    const row = await prisma.user_products.update({
      where: { id: Number(req.params.rowId) },
      data: forUpdate(req.user.id, { item_price: toPaise(req.body.item_price) }),
    });
    res.json(row);
  } catch (err) {
    next(err);
  }
}

export async function deleteCustomerFlatPrice(req, res, next) {
  try {
    const { error } = await ownRow(prisma.user_products, req.params.rowId, req.params.id);
    if (error) return fail(res, error);

    await prisma.user_products.update({
      where: { id: Number(req.params.rowId) },
      data: forSoftDelete(req.user.id),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// --- customer quantity tiers (user_products_multipricing) --------------------

export async function createCustomerTier(req, res, next) {
  try {
    const customer = await findCustomer(req.params.id);
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const { product_id, quantity, price, label } = req.body;
    const badQty = quantityError(quantity);
    if (badQty) return res.status(400).json({ message: badQty });
    const badPrice = priceError(price);
    if (badPrice) return res.status(400).json({ message: badPrice });

    const product = await findProduct(product_id);
    if (!product) return res.status(400).json({ message: "Unknown product" });

    // Rule 2: two tiers at the same quantity make the winner arbitrary.
    const clash = await prisma.user_products_multipricing.findFirst({
      where: {
        user_id: customer.id,
        product_id: product.id,
        quantity: Number(quantity),
        ...ACTIVE,
      },
      select: { id: true },
    });
    if (clash) {
      return res.status(409).json({
        message: `A tier at quantity ${quantity} already exists for this product and customer.`,
        id: clash.id,
      });
    }

    const row = await prisma.user_products_multipricing.create({
      data: forCreate(req.user.id, {
        user_id: customer.id,
        product_id: product.id,
        quantity: Number(quantity),
        price: toPaise(price),
        // Free text and display-only: the engine never parses it.
        label: label?.trim() || null,
      }),
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

export async function updateCustomerTier(req, res, next) {
  try {
    const { row, error } = await ownRow(
      prisma.user_products_multipricing,
      req.params.rowId,
      req.params.id,
    );
    if (error) return fail(res, error);

    const { quantity, price, label } = req.body;
    const data = {};

    if (quantity !== undefined) {
      const bad = quantityError(quantity);
      if (bad) return res.status(400).json({ message: bad });

      const clash = await prisma.user_products_multipricing.findFirst({
        where: {
          user_id: Number(req.params.id),
          product_id: row.product_id,
          quantity: Number(quantity),
          id: { not: row.id },
          ...ACTIVE,
        },
        select: { id: true },
      });
      if (clash) {
        return res.status(409).json({ message: `A tier at quantity ${quantity} already exists.` });
      }
      data.quantity = Number(quantity);
    }

    if (price !== undefined) {
      const bad = priceError(price);
      if (bad) return res.status(400).json({ message: bad });
      data.price = toPaise(price);
    }

    if (label !== undefined) data.label = label?.trim() || null;

    const updated = await prisma.user_products_multipricing.update({
      where: { id: row.id },
      data: forUpdate(req.user.id, data),
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteCustomerTier(req, res, next) {
  try {
    const { error } = await ownRow(
      prisma.user_products_multipricing,
      req.params.rowId,
      req.params.id,
    );
    if (error) return fail(res, error);

    await prisma.user_products_multipricing.update({
      where: { id: Number(req.params.rowId) },
      data: forSoftDelete(req.user.id),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// --- global quantity tiers (product_pricing) ---------------------------------
// These apply to every customer who has no more specific row, so they sit behind
// the Products module rather than Customers.

export async function createProductTier(req, res, next) {
  try {
    const product = await findProduct(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });

    const { quantity, price, label } = req.body;
    const badQty = quantityError(quantity);
    if (badQty) return res.status(400).json({ message: badQty });
    const badPrice = priceError(price);
    if (badPrice) return res.status(400).json({ message: badPrice });

    const clash = await prisma.product_pricing.findFirst({
      where: { product_id: product.id, quantity: Number(quantity), ...ACTIVE },
      select: { id: true },
    });
    if (clash) {
      return res.status(409).json({
        message: `A tier at quantity ${quantity} already exists for this product.`,
        id: clash.id,
      });
    }

    const row = await prisma.product_pricing.create({
      data: forCreate(req.user.id, {
        product_id: product.id,
        quantity: Number(quantity),
        price: toPaise(price),
        label: label?.trim() || null,
      }),
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

export async function updateProductTier(req, res, next) {
  try {
    const row = await prisma.product_pricing.findFirst({
      where: { id: Number(req.params.rowId), product_id: Number(req.params.id), ...ACTIVE },
      select: { id: true, product_id: true },
    });
    if (!row) return res.status(404).json({ message: "Tier not found on this product" });

    const { quantity, price, label } = req.body;
    const data = {};

    if (quantity !== undefined) {
      const bad = quantityError(quantity);
      if (bad) return res.status(400).json({ message: bad });

      const clash = await prisma.product_pricing.findFirst({
        where: {
          product_id: row.product_id,
          quantity: Number(quantity),
          id: { not: row.id },
          ...ACTIVE,
        },
        select: { id: true },
      });
      if (clash) {
        return res.status(409).json({ message: `A tier at quantity ${quantity} already exists.` });
      }
      data.quantity = Number(quantity);
    }

    if (price !== undefined) {
      const bad = priceError(price);
      if (bad) return res.status(400).json({ message: bad });
      data.price = toPaise(price);
    }

    if (label !== undefined) data.label = label?.trim() || null;

    const updated = await prisma.product_pricing.update({
      where: { id: row.id },
      data: forUpdate(req.user.id, data),
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteProductTier(req, res, next) {
  try {
    const row = await prisma.product_pricing.findFirst({
      where: { id: Number(req.params.rowId), product_id: Number(req.params.id), ...ACTIVE },
      select: { id: true },
    });
    if (!row) return res.status(404).json({ message: "Tier not found on this product" });

    await prisma.product_pricing.update({
      where: { id: row.id },
      data: forSoftDelete(req.user.id),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
