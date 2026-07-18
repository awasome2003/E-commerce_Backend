import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { ACTIVE } from "../lib/records.js";

/**
 * Verifies the JWT and loads the live user + role on every request.
 *
 * The user is re-read rather than trusted from the token body so that a
 * deactivated account or a role change takes effect immediately instead of
 * lingering until the token expires.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  try {
    const user = await prisma.users.findFirst({
      where: { id: payload.id, ...ACTIVE },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role_id: true,
        master_roles: { select: { id: true, title: true } },
      },
    });

    if (!user) {
      return res.status(401).json({ message: "User no longer exists" });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Storefront guard.
 *
 * The module permission matrix describes staff access to admin modules, and both
 * Customer roles score zero on every module — so it cannot express "may shop".
 * Customers are identified by their role title instead. Two roles share the title
 * "Customer" (id 5 is retired, id 6 active), which is why this matches on the
 * title rather than an id.
 */
export function requireCustomer(req, res, next) {
  if (req.user?.master_roles?.title !== "Customer") {
    return res.status(403).json({ message: "This area is for customers only" });
  }
  next();
}
