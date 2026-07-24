// One-off migration runner: applies the Tier 1 auth-lifecycle columns to whatever
// database URL you pass on the command line — no .env, no shell env pollution.
//
//   node prisma/migrations-manual/run.mjs "mysql://user:pass@host:port/db"
//
// It prints the target host (so you can confirm it's the right DB), is safe to
// re-run (a second run reports "already applied"), and verifies the result.
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";

const dbUrl = process.argv[2];
if (!dbUrl) {
  console.error('Usage: node prisma/migrations-manual/run.mjs "<DATABASE_URL>"');
  process.exit(1);
}

const u = new URL(dbUrl);
console.log(`\n  Target ->  host: ${u.hostname}   db: ${u.pathname.replace(/^\//, "")}\n`);

const adapter = new PrismaMariaDb({
  host: u.hostname,
  port: Number(u.port) || 3306,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ""),
  allowPublicKeyRetrieval: true,
});
const prisma = new PrismaClient({ adapter });

try {
  await prisma.$executeRawUnsafe(
    "ALTER TABLE users " +
      "ADD COLUMN token_version INT NOT NULL DEFAULT 0, " +
      "ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0, " +
      "ADD COLUMN locked_until TIMESTAMP(6) NULL DEFAULT NULL",
  );
  console.log("  ✓ Migration applied.");
} catch (e) {
  if (/Duplicate column|already exists/i.test(e.message)) {
    console.log("  • Columns already exist — nothing to do.");
  } else {
    console.error("  ✗ Migration failed:", e.message);
    await prisma.$disconnect();
    process.exit(1);
  }
}

const rows = await prisma.$queryRawUnsafe(
  "SELECT COUNT(*) AS n FROM information_schema.columns " +
    "WHERE table_schema = DATABASE() AND table_name = 'users' " +
    "AND column_name IN ('token_version','failed_login_attempts','locked_until')",
);
console.log(`  Columns present now: ${Number(rows[0].n)}  (expect 3)\n`);
await prisma.$disconnect();
