import { prisma } from "../lib/prisma.js";
import { ACTIVE } from "../lib/records.js";

/** Module titles as stored in `master_module`. */
export const MODULES = {
  PRODUCTS: "Products",
  ORDERS: "Orders",
  SUPPORT: "Support",
  BRANDS: "Brands",
  SETTINGS: "Settings",
  CUSTOMERS: "Customers",
  BANNER_ADS: "Banner Ads",
  NOTIFICATION: "Notification",
  COUPON: "Coupon",
};

/** Permission flags are stored as tinyint columns named after the action. */
export const ACTIONS = ["create", "read", "update", "delete"];

/**
 * Reads the permission matrix for a role as { [moduleTitle]: {create,read,update,delete} }.
 *
 * Absence of a row means "no access": permissions are granted only by data, with
 * no superuser bypass, so the API and the UI agree on what a role can do.
 */
export async function getPermissions(roleId) {
  if (!roleId) return {};

  const rows = await prisma.master_role_permissions.findMany({
    // Join through active modules only. `Brands` (id 4) is soft-deleted but
    // Manager still has a permission row pointing at it; a retired module must
    // not grant access.
    where: { role_id: roleId, ...ACTIVE, master_module: ACTIVE },
    select: {
      create: true,
      read: true,
      update: true,
      delete: true,
      master_module: { select: { title: true } },
    },
  });

  const matrix = {};
  for (const row of rows) {
    const title = row.master_module?.title;
    if (!title) continue;
    matrix[title] = {
      create: row.create === 1,
      read: row.read === 1,
      update: row.update === 1,
      delete: row.delete === 1,
    };
  }
  return matrix;
}

/**
 * Guards a route that isn't owned by any single module — the dashboard spans
 * products, orders, customers and tickets, and the lookup lists feed every screen.
 *
 * "Staff" means the role has read on at least one module. Customers score zero on
 * the whole matrix, so this excludes them without hardcoding a role. Without it,
 * a route protected only by `requireAuth` is readable by any signed-in customer —
 * which is how the dashboard was leaking revenue and customer counts.
 */
export async function requireStaff(req, res, next) {
  try {
    const matrix = await getPermissions(req.user?.role_id);
    const hasAnyRead = Object.values(matrix).some((m) => m.read);
    if (hasAnyRead) return next();
    res.status(403).json({ message: "Staff access required" });
  } catch (err) {
    next(err);
  }
}

/** Guards a route behind one module/action pair from the permission matrix. */
export function requirePermission(moduleTitle, action) {
  return async (req, res, next) => {
    try {
      const matrix = await getPermissions(req.user?.role_id);
      if (matrix[moduleTitle]?.[action]) return next();

      res.status(403).json({
        message: `Your role does not have '${action}' permission on '${moduleTitle}'`,
      });
    } catch (err) {
      next(err);
    }
  };
}
