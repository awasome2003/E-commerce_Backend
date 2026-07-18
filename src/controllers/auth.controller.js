import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate } from "../lib/records.js";
import { getPermissions } from "../middleware/rbac.js";

/**
 * A role can reach the admin panel if it has read access to at least one module.
 * Customer roles have an all-zero permission matrix and so are rejected here.
 */
async function rolesWithPanelAccess() {
  const rows = await prisma.master_role_permissions.findMany({
    where: { read: 1, ...ACTIVE },
    select: { role_id: true },
    distinct: ["role_id"],
  });
  return rows.map((r) => r.role_id).filter((id) => id !== null);
}

function publicUser(user) {
  return {
    id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    role_id: user.role_id,
    role: user.master_roles?.title ?? null,
    profile_image_url: user.profile_image_url ?? null,
  };
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "email and password are required" });
    }

    const panelRoles = await rolesWithPanelAccess();

    // `users.email` has no unique constraint and this database really does
    // contain one address shared by an Admin and a Customer row. Restricting to
    // panel-capable roles disambiguates, and we still verify the password
    // against each candidate rather than assuming the first row is the right one.
    const candidates = await prisma.users.findMany({
      where: { email, role_id: { in: panelRoles }, ...ACTIVE },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        password: true,
        role_id: true,
        profile_image_url: true,
        master_roles: { select: { id: true, title: true } },
      },
    });

    let authenticated = null;
    for (const candidate of candidates) {
      if (candidate.password && (await bcrypt.compare(password, candidate.password))) {
        authenticated = candidate;
        break;
      }
    }

    if (!authenticated) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: authenticated.id, role_id: authenticated.role_id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({
      token,
      user: publicUser(authenticated),
      permissions: await getPermissions(authenticated.role_id),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Storefront login.
 *
 * Deliberately separate from the admin login and scoped to the Customer role.
 * The scoping is not cosmetic: one email in this database belongs to *both* an
 * Admin (id 1) and a Customer (id 74), and `users.email` has no unique
 * constraint — so each door must only admit its own audience. The same address
 * signing in here authenticates as the customer; on the admin login, as the admin.
 */
export async function customerLogin(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "email and password are required" });
    }

    const candidates = await prisma.users.findMany({
      where: { email, master_roles: { title: "Customer" }, ...ACTIVE },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        password: true,
        role_id: true,
        profile_image_url: true,
        credit_limit: true,
        no_of_days: true,
        master_roles: { select: { id: true, title: true } },
      },
    });

    let authenticated = null;
    for (const candidate of candidates) {
      if (candidate.password && (await bcrypt.compare(password, candidate.password))) {
        authenticated = candidate;
        break;
      }
    }

    if (!authenticated) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: authenticated.id, role_id: authenticated.role_id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({
      token,
      user: {
        ...publicUser(authenticated),
        credit_limit: authenticated.credit_limit,
        no_of_days: authenticated.no_of_days,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Vendor self-registration.
 *
 * Creates a Customer account that can order immediately. Credit is *not* granted
 * here: `credit_limit` stays 0 and `no_of_days` null until staff set them, so a
 * new vendor cannot award themselves terms by signing up.
 *
 * Email uniqueness is enforced here because the database will not do it —
 * `users.email` has no unique constraint, and this data already contains one
 * address shared by an Admin and a Customer, which makes "who is this?"
 * ambiguous. We refuse any address already in use by *any* active user rather
 * than add to that mess.
 */
export async function register(req, res, next) {
  try {
    const { first_name, last_name, email, password, phone_number } = req.body;

    if (!first_name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ message: "first_name, email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      return res.status(400).json({ message: "That email address does not look valid" });
    }

    const taken = await prisma.users.findFirst({
      where: { email: email.trim(), ...ACTIVE },
      select: { id: true },
    });
    if (taken) {
      return res.status(409).json({ message: "An account with that email already exists" });
    }

    const role = await prisma.master_roles.findFirst({
      where: { title: "Customer", ...ACTIVE },
      select: { id: true },
    });
    if (!role) {
      return res.status(500).json({ message: "No customer role is configured" });
    }

    // Same cost as every existing hash in this database ($2a$10$).
    const hashed = await bcrypt.hash(password, 10);

    const created = await prisma.users.create({
      data: forCreate(null, {
        first_name: first_name.trim(),
        last_name: last_name?.trim() || null,
        email: email.trim(),
        phone_number: phone_number?.trim() || null,
        password: hashed,
        role_id: role.id,
        credit_limit: 0,
        no_of_days: null,
      }),
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role_id: true,
        profile_image_url: true,
        credit_limit: true,
        no_of_days: true,
        master_roles: { select: { id: true, title: true } },
      },
    });

    // Signed straight in: making someone register and then log in again is a
    // pointless second hurdle.
    const token = jwt.sign({ id: created.id, role_id: created.role_id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({
      token,
      user: {
        ...publicUser(created),
        credit_limit: created.credit_limit,
        no_of_days: created.no_of_days,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function me(req, res, next) {
  try {
    res.json({
      user: publicUser(req.user),
      permissions: await getPermissions(req.user.role_id),
    });
  } catch (err) {
    next(err);
  }
}
