import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate } from "../lib/records.js";
import { getPermissions, areasFor } from "../middleware/rbac.js";

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

const CANDIDATE_SELECT = {
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
};

function issueToken(user) {
  return jwt.sign({ id: user.id, role_id: user.role_id }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "7d",
  });
}

/**
 * The single sign-in for everyone — staff and customers alike.
 *
 * There is one door and one token; where you land afterwards is decided by the
 * permission matrix (see `areasFor`), not by which endpoint you used.
 *
 * Ambiguity is handled rather than guessed at. `users.email` has no unique
 * constraint, so two accounts could share an address. The password is therefore
 * checked against **every** active account with that email:
 *
 *   0 match  -> invalid credentials
 *   1 match  -> signed in
 *   2+ match -> 409 listing the accounts; the client re-sends with `user_id`
 *
 * Silently picking one would log somebody into the wrong identity.
 */
export async function login(req, res, next) {
  try {
    const { email, password, user_id } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "email and password are required" });
    }

    const candidates = await prisma.users.findMany({
      where: { email, ...ACTIVE },
      select: CANDIDATE_SELECT,
    });

    const matches = [];
    for (const candidate of candidates) {
      if (candidate.password && (await bcrypt.compare(password, candidate.password))) {
        matches.push(candidate);
      }
    }

    if (matches.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    let user = matches[0];

    if (matches.length > 1) {
      // The caller may disambiguate by re-sending with the chosen account id.
      const chosen = user_id ? matches.find((m) => m.id === Number(user_id)) : null;
      if (!chosen) {
        return res.status(409).json({
          message: "That email and password match more than one account. Choose one to continue.",
          accounts: matches.map((m) => ({
            user_id: m.id,
            role: m.master_roles?.title ?? null,
            name: [m.first_name, m.last_name].filter(Boolean).join(" ").trim() || m.email,
          })),
        });
      }
      user = chosen;
    }

    const permissions = await getPermissions(user.role_id);
    const areas = areasFor(permissions);

    // An account with no permissions at all can sign in but has nowhere to go —
    // say so plainly instead of dropping them on an empty screen.
    if (!areas.staff && !areas.shop) {
      return res.status(403).json({
        message: "Your account has no access configured. Please contact support.",
      });
    }

    res.json({
      token: issueToken(user),
      user: {
        ...publicUser(user),
        credit_limit: user.credit_limit,
        no_of_days: user.no_of_days,
      },
      permissions,
      areas,
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
 * `users.email` has no unique constraint. Any address already used by an active
 * user is refused, which is what keeps [login] unambiguous.
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

    // Cost 12 (above the legacy $2a$10$ hashes, which still verify; they can be
    // transparently upgraded on next successful login if desired).
    const hashed = await bcrypt.hash(password, 12);

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
      select: CANDIDATE_SELECT,
    });

    const permissions = await getPermissions(created.role_id);

    // Signed straight in: making someone register and then log in again is a
    // pointless second hurdle.
    res.status(201).json({
      token: issueToken(created),
      user: {
        ...publicUser(created),
        credit_limit: created.credit_limit,
        no_of_days: created.no_of_days,
      },
      permissions,
      areas: areasFor(permissions),
    });
  } catch (err) {
    next(err);
  }
}

/** The signed-in user, their permissions, and which areas they may enter. */
export async function me(req, res, next) {
  try {
    const permissions = await getPermissions(req.user.role_id);
    res.json({
      user: publicUser(req.user),
      permissions,
      areas: areasFor(permissions),
    });
  } catch (err) {
    next(err);
  }
}
