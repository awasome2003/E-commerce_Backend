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
