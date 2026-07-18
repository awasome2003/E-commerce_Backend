import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate, forUpdate, forSoftDelete } from "../lib/records.js";

/**
 * `inst_price` is the live selling price, not `product_price`.
 *
 * Every active product has product_price = 0, while 1,729 of 1,741 carry a real
 * inst_price — and cart/order lines on the active catalogue match inst_price and
 * never product_price. The legacy column only holds values on the soft-deleted
 * rows left behind by an earlier catalogue migration, so it is surfaced as
 * read-only history rather than treated as the price.
 */
const listSelect = {
  id: true,
  product_name: true,
  inst_price: true,
  product_price: true,
  item_number: true,
  is_active: true,
  tax: true,
  hsn_code: true,
  warehouse: true,
  moq: true,
  master_category: { select: { id: true, title: true } },
  master_sub_category: { select: { id: true, title: true } },
  master_brands: { select: { id: true, title: true } },
  // Prisma exposes the hyphenated DB enum values under sanitized identifiers,
  // so this is `slider_image`, not the literal "slider-image" stored in MySQL.
  product_images: {
    where: { ...ACTIVE, type: "slider_image" },
    select: { image_url: true },
    orderBy: { image_order: "asc" },
    take: 1,
  },
};

/** Editable columns. Anything not listed here is ignored on write. */
const WRITABLE = [
  "product_name",
  "product_description",
  "product_price",
  "category_id",
  "sub_category_id",
  "brand_id",
  "manufacturer_id",
  "item_number",
  "is_active",
  "hsn_code",
  "warehouse",
  "tax",
  "quantity_per_package",
  "weight_per_purchasing_unit",
  "weight_per_sales_unit",
  "inst_price",
  "moq",
];

function pickWritable(body) {
  const data = {};
  for (const key of WRITABLE) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  return data;
}

export async function listProducts(req, res, next) {
  try {
    const {
      search = "",
      category_id,
      sub_category_id,
      brand_id,
      is_active,
      page = "1",
      limit = "25",
      sort = "created_at",
      dir = "desc",
    } = req.query;

    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * take;

    const sortable = ["created_at", "product_name", "product_price", "id"];
    const orderBy = { [sortable.includes(sort) ? sort : "created_at"]: dir === "asc" ? "asc" : "desc" };

    const where = {
      ...ACTIVE,
      ...(search
        ? {
            OR: [
              { product_name: { contains: search } },
              { item_number: { contains: search } },
              { hsn_code: { contains: search } },
            ],
          }
        : {}),
      ...(category_id ? { category_id: Number(category_id) } : {}),
      ...(sub_category_id ? { sub_category_id: Number(sub_category_id) } : {}),
      ...(brand_id ? { brand_id: Number(brand_id) } : {}),
      ...(is_active !== undefined && is_active !== "" ? { is_active: Number(is_active) } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.products.findMany({ where, select: listSelect, orderBy, take, skip }),
      prisma.products.count({ where }),
    ]);

    res.json({
      items,
      total,
      page: currentPage,
      limit: take,
      pages: Math.ceil(total / take),
    });
  } catch (err) {
    next(err);
  }
}

export async function getProduct(req, res, next) {
  try {
    const product = await prisma.products.findFirst({
      where: { id: Number(req.params.id), ...ACTIVE },
      include: {
        master_category: { select: { id: true, title: true } },
        master_sub_category: { select: { id: true, title: true } },
        master_brands: { select: { id: true, title: true } },
        master_manufacturers: { select: { id: true, title: true } },
        product_images: {
          where: ACTIVE,
          select: { id: true, image_url: true, image_order: true, type: true },
          orderBy: { image_order: "asc" },
        },
        product_pricing: {
          where: ACTIVE,
          select: { id: true, quantity: true, price: true, label: true },
          orderBy: { quantity: "asc" },
        },
      },
      // The embedding column holds a large vector used for semantic search and is
      // never needed by the admin UI; omitting it keeps the payload small.
      omit: { embedding: true },
    });

    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(product);
  } catch (err) {
    next(err);
  }
}

export async function createProduct(req, res, next) {
  try {
    const data = pickWritable(req.body);
    if (!data.product_name || data.inst_price === undefined) {
      return res.status(400).json({ message: "product_name and inst_price are required" });
    }
    // NOT NULL with no default, and dead on the active catalogue — see listSelect.
    data.product_price ??= 0;

    const product = await prisma.products.create({
      data: forCreate(req.user.id, data),
      omit: { embedding: true },
    });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
}

export async function updateProduct(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.products.findFirst({ where: { id, ...ACTIVE }, select: { id: true } });
    if (!existing) return res.status(404).json({ message: "Product not found" });

    const product = await prisma.products.update({
      where: { id },
      data: forUpdate(req.user.id, pickWritable(req.body)),
      omit: { embedding: true },
    });
    res.json(product);
  } catch (err) {
    next(err);
  }
}

export async function deleteProduct(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.products.findFirst({ where: { id, ...ACTIVE }, select: { id: true } });
    if (!existing) return res.status(404).json({ message: "Product not found" });

    await prisma.products.update({ where: { id }, data: forSoftDelete(req.user.id) });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
