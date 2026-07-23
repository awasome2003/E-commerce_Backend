import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { ACTIVE, forCreate, forUpdate } from "../src/lib/records.js";

/**
 * Makes the permission matrix govern *everyone*, so there is one login and one
 * authorisation model.
 *
 * Two problems this fixes:
 *
 * 1. Customers had ZERO rows in `master_role_permissions`, so the matrix could
 *    not express "may use the storefront" — customer access had to be decided by
 *    role *title*, while staff access used the matrix. Adding a `Storefront`
 *    module and granting it to the Customer role removes that special case.
 *
 * 2. One email (`sha***@gmail.com`) belonged to BOTH an Admin (id 1) and a
 *    Customer (id 74). With separate logins that was merely odd; with a single
 *    login it is ambiguous. Confirmed as dummy data, so the customer copy is
 *    given a distinct address.
 *
 * Idempotent — safe to re-run. **Also run against the upstream RDS.**
 *
 * Pass `--dry-run` to print what would change without writing anything. Use it
 * before running against a shared database: the email de-duplication rewrites
 * real rows, and another environment may contain duplicates this one does not.
 *
 *   node scripts/unify-rbac.js --dry-run
 */

const DRY_RUN = process.argv.includes("--dry-run");
const STOREFRONT = "Storefront";

if (DRY_RUN) console.log("DRY RUN — no changes will be written\n");

// --- 1. the Storefront module -----------------------------------------------
let module_ = await prisma.master_module.findFirst({
  where: { title: STOREFRONT, ...ACTIVE },
  select: { id: true },
});

if (module_) {
  console.log(`module '${STOREFRONT}' already exists (id=${module_.id})`);
} else if (DRY_RUN) {
  console.log(`would CREATE module '${STOREFRONT}'`);
} else {
  module_ = await prisma.master_module.create({
    data: forCreate(null, { title: STOREFRONT }),
    select: { id: true },
  });
  console.log(`module '${STOREFRONT}' created (id=${module_.id})`);
}

// --- 2. grant it to every active Customer role ------------------------------
// A customer only ever touches their own cart, outlets and orders, so all four
// actions simply mean "may use the storefront".
const customerRoles = await prisma.master_roles.findMany({
  where: { title: "Customer", ...ACTIVE },
  select: { id: true, title: true },
});

for (const role of customerRoles) {
  if (!module_) {
    console.log(`role ${role.id} (${role.title}): would GRANT Storefront (module not created yet)`);
    continue;
  }

  const existing = await prisma.master_role_permissions.findFirst({
    where: { role_id: role.id, module_id: module_.id, ...ACTIVE },
    select: { id: true },
  });

  const flags = { create: 1, read: 1, update: 1, delete: 1 };

  if (DRY_RUN) {
    console.log(
      `role ${role.id} (${role.title}): would ${existing ? "REFRESH" : "GRANT"} Storefront`,
    );
  } else if (existing) {
    await prisma.master_role_permissions.update({
      where: { id: existing.id },
      data: forUpdate(null, flags),
    });
    console.log(`role ${role.id} (${role.title}): Storefront permission refreshed`);
  } else {
    await prisma.master_role_permissions.create({
      data: forCreate(null, { ...flags, role_id: role.id, module_id: module_.id }),
    });
    console.log(`role ${role.id} (${role.title}): Storefront permission granted`);
  }
}

// Staff roles must NOT get Storefront — it is what separates the two areas.
const staffWithStorefront = await prisma.master_role_permissions.count({
  where: {
    module_id: module_.id,
    ...ACTIVE,
    master_roles: { title: { not: "Customer" }, ...ACTIVE },
  },
});
console.log(`staff roles holding Storefront (should be 0): ${staffWithStorefront}`);

// --- 3. de-duplicate active emails ------------------------------------------
const withEmail = await prisma.users.findMany({
  where: { ...ACTIVE, email: { not: null } },
  select: { id: true, email: true, role_id: true, master_roles: { select: { title: true } } },
  orderBy: { id: "asc" },
});

const byEmail = new Map();
for (const u of withEmail) {
  if (!byEmail.has(u.email)) byEmail.set(u.email, []);
  byEmail.get(u.email).push(u);
}

let fixed = 0;
for (const [email, accounts] of byEmail) {
  if (accounts.length < 2) continue;
  // Keep the lowest id (the original); rewrite the rest to a distinct address so
  // a single login can never be ambiguous.
  const [keep, ...duplicates] = accounts;
  for (const dup of duplicates) {
    const [name, domain] = email.split("@");
    const replacement = `${name}+dup${dup.id}@${domain}`;

    if (DRY_RUN) {
      // Show enough to judge whether these are dummy rows or real people.
      console.log(
        `would RENAME user ${dup.id} (${dup.master_roles?.title}) ` +
          `— keeping id ${keep.id} (${keep.master_roles?.title}) on ${email}\n` +
          `    new address: ${replacement}`,
      );
    } else {
      await prisma.users.update({
        where: { id: dup.id },
        data: forUpdate(null, { email: replacement }),
      });
      console.log(
        `user ${dup.id} (${dup.master_roles?.title}): email de-duplicated -> ${replacement}`,
      );
    }
    fixed += 1;
  }
}
console.log(
  fixed === 0
    ? "no duplicate active emails"
    : DRY_RUN
      ? `would de-duplicate ${fixed} account(s)`
      : `de-duplicated ${fixed} account(s)`,
);

// --- verify ------------------------------------------------------------------
const stillDuplicated = await prisma.$queryRawUnsafe(
  `SELECT COUNT(*) AS n FROM (
     SELECT email FROM users
     WHERE deleted_at IS NULL AND email IS NOT NULL
     GROUP BY email HAVING COUNT(*) > 1
   ) x`,
);
console.log(`\nduplicate active emails remaining: ${Number(stillDuplicated[0].n)}`);
console.log("Run `npx prisma db pull && npx prisma generate` is NOT needed (no schema change).");

await prisma.$disconnect();
