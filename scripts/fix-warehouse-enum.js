import "dotenv/config";
import mariadb from "mariadb";

/**
 * Repairs invalid values in `products.warehouse`.
 *
 * The column is `enum('S1-DRY','S1-FRZN','S1-CHLD')`, but 1,761 rows store an
 * empty string — not a member of the enum. MySQL accepted it under non-strict
 * mode; Prisma refuses to decode it (`P2023`), which breaks EVERY product query.
 *
 * `''` means "unspecified", so the rows are set to NULL (the column is nullable).
 *
 * Pass `--dry-run` to count affected rows without writing.
 * Idempotent — safe to re-run.
 *
 * Uses the raw driver rather than Prisma on purpose: Prisma cannot read these
 * rows, which is the very problem being fixed.
 */

const DRY_RUN = process.argv.includes("--dry-run");
if (DRY_RUN) console.log("DRY RUN — no changes will be written\n");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const dsn = new URL(url);
const conn = await mariadb.createConnection({
  host: dsn.hostname,
  port: Number(dsn.port) || 3306,
  user: decodeURIComponent(dsn.username),
  password: decodeURIComponent(dsn.password),
  database: dsn.pathname.replace(/^\//, ""),
});

console.log(`connected to ${dsn.hostname}${dsn.pathname}\n`);

// A direct comparison against '' is safe here; YEAR()-style tricks are not needed
// because the invalid value is the empty string, not an out-of-range date.
const [before] = await conn.query(
  `SELECT COUNT(*) AS n FROM products WHERE warehouse = ''`,
);
const affected = Number(before.n);
console.log(`rows with an invalid empty warehouse: ${affected}`);

if (affected === 0) {
  console.log("nothing to fix");
} else if (DRY_RUN) {
  console.log(`would SET warehouse = NULL on ${affected} row(s)`);
} else {
  const res = await conn.query(`UPDATE products SET warehouse = NULL WHERE warehouse = ''`);
  console.log(`set warehouse = NULL on ${res.affectedRows} row(s)`);
}

const [after] = await conn.query(`SELECT COUNT(*) AS n FROM products WHERE warehouse = ''`);
console.log(`\nremaining invalid rows: ${Number(after.n)}`);

const dist = await conn.query(
  `SELECT COALESCE(warehouse, '(null)') AS warehouse, COUNT(*) AS n
   FROM products GROUP BY warehouse ORDER BY n DESC`,
);
console.log("distribution:");
for (const row of dist) console.log(`  ${String(row.warehouse).padEnd(10)} ${Number(row.n)}`);

await conn.end();
