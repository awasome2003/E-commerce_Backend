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
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
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

// The storefront guard used to match on the role *title*, because customers had
// no permission rows at all. They now hold the `Storefront` module, so the
// storefront is guarded by the same matrix as everything else — see
// `requirePermission(MODULES.STOREFRONT, …)` in the routes.
