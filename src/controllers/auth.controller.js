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
  token_version: true,
  failed_login_attempts: true,
  locked_until: true,
  master_roles: { select: { id: true, title: true } },
};

// Per-account brute-force lockout policy.
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_MINUTES = 15;
// A throwaway hash so a login for a non-existent email still spends ~one bcrypt
// compare — removes the timing side-channel that would otherwise reveal which
// emails exist.
const DUMMY_HASH = bcrypt.hashSync("timing-normalisation-placeholder", 10);

function issueToken(user) {
  return jwt.sign(
    { id: user.id, role_id: user.role_id, tv: user.token_version ?? 0 },
    process.env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "7d" },
  );
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

    // Per-account lockout: if the account(s) on this email are inside a lock
    // window, refuse before spending any bcrypt time.
    const now = new Date();
    if (candidates.some((c) => c.locked_until && new Date(c.locked_until) > now)) {
      return res
        .status(429)
        .json({ message: "Too many failed attempts. Please try again in a few minutes." });
    }

    // Normalise timing for a non-existent email so it cannot be told apart from a
    // wrong password by response latency (account enumeration).
    if (candidates.length === 0) {
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const matches = [];
    for (const candidate of candidates) {
      if (candidate.password && (await bcrypt.compare(password, candidate.password))) {
        matches.push(candidate);
      }
    }

    if (matches.length === 0) {
      // Count the failure against every account on this email, and lock them once
      // the threshold is crossed.
      await prisma.users.updateMany({
        where: { email, ...ACTIVE },
        data: { failed_login_attempts: { increment: 1 } },
      });
      const after = await prisma.users.findFirst({
        where: { email, ...ACTIVE },
        orderBy: { failed_login_attempts: "desc" },
        select: { failed_login_attempts: true },
      });
      if (after && after.failed_login_attempts >= MAX_FAILED_ATTEMPTS) {
        await prisma.users.updateMany({
          where: { email, ...ACTIVE },
          data: { locked_until: new Date(Date.now() + LOCK_MINUTES * 60000), failed_login_attempts: 0 },
        });
      }
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Correct password for at least one account — clear any failure/lock state.
    if (candidates.some((c) => c.failed_login_attempts > 0 || c.locked_until)) {
      await prisma.users.updateMany({
        where: { email, ...ACTIVE },
        data: { failed_login_attempts: 0, locked_until: null },
      });
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

/**
 * Real logout — bumps the user's token_version so every token issued for this
 * account (this device and any other) stops verifying on the next request.
 */
export async function logout(req, res, next) {
  try {
    await prisma.users.update({
      where: { id: req.user.id },
      data: { token_version: { increment: 1 } },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/**
 * Change the signed-in user's password. Verifies the current password, stores a
 * fresh bcrypt (cost 12) hash, and bumps token_version so every *other* session
 * is invalidated; a new token is returned so the current device stays signed in.
 */
export async function changePassword(req, res, next) {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ message: "current_password and new_password are required" });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }

    const user = await prisma.users.findFirst({
      where: { id: req.user.id, ...ACTIVE },
      select: { id: true, password: true, role_id: true },
    });
    if (!user || !user.password || !(await bcrypt.compare(current_password, user.password))) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    const hashed = await bcrypt.hash(new_password, 12);
    const updated = await prisma.users.update({
      where: { id: user.id },
      data: { password: hashed, token_version: { increment: 1 } },
      select: { id: true, role_id: true, token_version: true },
    });

    res.json({ token: issueToken(updated) });
  } catch (err) {
    next(err);
  }
}
