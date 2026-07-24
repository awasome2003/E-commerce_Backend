import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma.js";
import { ACTIVE, forCreate, forUpdate } from "../src/lib/records.js";

/**
 * Creates a throwaway Admin login for local development.
 *
 * The imported dump contains real users whose passwords are unknown, so rather
 * than resetting a real person's credentials we add a dedicated account.
 */
const EMAIL = "dev.admin@local.test";
const PASSWORD = "admin123";

// Guard: never plant a known-password Admin anywhere but a local database. This
// script uses whatever DATABASE_URL is set — refuse if that is not loopback (a
// documented operator footgun runs seed scripts in a shell pointed at RDS).
const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1"].includes(dbHost) || process.env.NODE_ENV === "production") {
  console.error(
    `Refusing to run: DATABASE_URL host "${dbHost}" is not loopback (or NODE_ENV=production). ` +
      `Dev seed scripts only run against a local database.`,
  );
  process.exit(1);
}

const adminRole = await prisma.master_roles.findFirst({
  where: { title: "Admin", ...ACTIVE },
  select: { id: true },
});

if (!adminRole) {
  console.error("No 'Admin' role found in master_roles.");
  process.exit(1);
}

const password = await bcrypt.hash(PASSWORD, 10);
const existing = await prisma.users.findFirst({
  where: { email: EMAIL },
  select: { id: true },
});

if (existing) {
  await prisma.users.update({
    where: { id: existing.id },
    data: forUpdate(null, { password, role_id: adminRole.id, deleted_at: null }),
  });
  console.log(`Updated existing dev admin (id=${existing.id})`);
} else {
  const created = await prisma.users.create({
    data: forCreate(null, {
      first_name: "Dev",
      last_name: "Admin",
      email: EMAIL,
      user_name: "devadmin",
      password,
      role_id: adminRole.id,
    }),
    select: { id: true },
  });
  console.log(`Created dev admin (id=${created.id})`);
}

console.log(`\nLogin:  ${EMAIL}\nPass:   ${PASSWORD}`);
await prisma.$disconnect();
