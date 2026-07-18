import { prisma } from "../lib/prisma.js";
import { ACTIVE } from "../lib/records.js";

/**
 * Read-only lookup lists that populate filters and dropdowns across the panel.
 */

export async function listCategories(req, res, next) {
  try {
    res.json(
      await prisma.master_category.findMany({
        where: ACTIVE,
        select: { id: true, title: true, image_url: true, color: true },
        orderBy: { title: "asc" },
      }),
    );
  } catch (err) {
    next(err);
  }
}

export async function listSubCategories(req, res, next) {
  try {
    const { category_id } = req.query;
    res.json(
      await prisma.master_sub_category.findMany({
        where: { ...ACTIVE, ...(category_id ? { category_id: Number(category_id) } : {}) },
        select: { id: true, title: true, category_id: true },
        orderBy: { title: "asc" },
      }),
    );
  } catch (err) {
    next(err);
  }
}

export async function listBrands(req, res, next) {
  try {
    res.json(
      await prisma.master_brands.findMany({
        where: ACTIVE,
        select: { id: true, title: true, image_url: true },
        orderBy: { title: "asc" },
      }),
    );
  } catch (err) {
    next(err);
  }
}

export async function listManufacturers(req, res, next) {
  try {
    res.json(
      await prisma.master_manufacturers.findMany({
        where: ACTIVE,
        select: { id: true, title: true },
        orderBy: { title: "asc" },
      }),
    );
  } catch (err) {
    next(err);
  }
}

export async function listCustomerCategories(req, res, next) {
  try {
    res.json(
      await prisma.master_customer_category.findMany({
        where: ACTIVE,
        select: { id: true, title: true },
        orderBy: { title: "asc" },
      }),
    );
  } catch (err) {
    next(err);
  }
}

export async function listRoles(req, res, next) {
  try {
    res.json(
      await prisma.master_roles.findMany({
        where: ACTIVE,
        select: { id: true, title: true },
        orderBy: { id: "asc" },
      }),
    );
  } catch (err) {
    next(err);
  }
}
