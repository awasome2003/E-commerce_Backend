import "dotenv/config";
import mariadb from "mariadb";

/**
 * Repairs MySQL zero-dates (`0000-00-00 00:00:00`).
 *
 * Why this exists
 * ---------------
 * 59 of 67 purchase orders store 0000-00-00 in BOTH `po_date` and
 * `delivery_date`, and 4 banner rows do the same in `date_to`. MySQL's
 * non-strict mode accepted them (the same root cause as the empty
 * `products.warehouse` enum).
 *
 * These are not merely ugly: the mariadb driver throws `RangeError: Invalid time
 * value` while DECODING the row, so any Prisma query touching the column fails
 * outright — the whole Documents page returned HTTP 500. No application-side
 * guard can help, because the query never returns.
 *
 * The columns are NOT NULL, so the correct value cannot be written until the
 * column allows it. A NOT NULL date that is absent in 88% of rows is already
 * broken; making it nullable states the truth.
 *
 * Idempotent — safe to re-run. **Must also be run against the upstream RDS**, or
 * the next dump reintroduces rows that crash the API.
 *
 * Uses the raw driver rather than Prisma on purpose: Prisma cannot read these
 * rows, which is the very problem being fixed.
 */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// The raw driver only accepts a `mariadb://` URL; DATABASE_URL is `mysql://`
// (which the Prisma adapter translates for us). Parse it into a config instead
// of rewriting the scheme, so credentials with odd characters survive.
const dsn = new URL(url);
const conn = await mariadb.createConnection({
  host: dsn.hostname,
  port: Number(dsn.port) || 3306,
  user: decodeURIComponent(dsn.username),
  password: decodeURIComponent(dsn.password),
  database: dsn.pathname.replace(/^\//, ""),
});

async function column(table, name) {
  const [row] = await conn.query(
    `SELECT IS_NULLABLE AS nullable FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, name],
  );
  return row;
}

const TARGETS = [
  { table: "purchase_order", columns: ["po_date", "delivery_date"], type: "datetime" },
  { table: "master_banner_ads", columns: ["date_from", "date_to"], type: "datetime" },
];

for (const { table, columns, type } of TARGETS) {
  for (const name of columns) {
    const meta = await column(table, name);
    if (!meta) {
      console.log(`skip ${table}.${name} — column not found`);
      continue;
    }

    if (meta.nullable === "NO") {
      // Zero-dates cannot be cleared while the column rejects NULL.
      await conn.query(`ALTER TABLE \`${table}\` MODIFY \`${name}\` ${type} NULL`);
      console.log(`${table}.${name}: NOT NULL -> NULL`);
    } else {
      console.log(`${table}.${name}: already nullable`);
    }

    // YEAR() is the safest way to spot a zero-date; a direct comparison against
    // '0000-00-00' is itself an invalid literal under strict mode.
    const res = await conn.query(
      `UPDATE \`${table}\` SET \`${name}\` = NULL WHERE \`${name}\` IS NOT NULL AND YEAR(\`${name}\`) < 1000`,
    );
    console.log(`${table}.${name}: cleared ${res.affectedRows} zero-date row(s)`);
  }
}

console.log("\nVerifying no zero-dates remain:");
for (const { table, columns } of TARGETS) {
  for (const name of columns) {
    const [row] = await conn.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${name}\` IS NOT NULL AND YEAR(\`${name}\`) < 1000`,
    );
    console.log(`  ${table}.${name}: ${row.n} remaining`);
  }
}

console.log("\nRun `npx prisma db pull && npx prisma generate` — the columns are now optional.");
await conn.end();
