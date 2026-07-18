import "dotenv/config";
import mariadb from "mariadb";
import { randomUUID } from "node:crypto";

/**
 * Adds delivery-charge configuration.
 *
 * Why a new table
 * ---------------
 * The database has no settings/config table of any kind, so there is nowhere to
 * record "flat rate = 250". Delivery charges were previously typed in per order
 * by hand — the values in `orders.delivery_charge` (0, 1, 20, 49, 79, 150, 250,
 * 1700) follow no rule and do not track cart size at all.
 *
 * Why `distance_km` on the outlet
 * -------------------------------
 * Per-km pricing needs a distance, and there is no location data anywhere in the
 * schema — no lat/lng, no pincode. Outlet addresses are free text like
 * "Thane, Maharasthra". Rather than depend on geocoding a misspelled string,
 * distance is entered once per outlet by an admin. There are only 27 outlets.
 *
 * Money columns use `decimal(10,2)`, deliberately breaking with the rest of this
 * schema. Every existing money column is `float`, which cannot represent 185.67
 * and drifts when summed. New columns should not inherit that.
 *
 * Idempotent — safe to re-run. **Also run against the upstream RDS.**
 */

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

// The mariadb driver returns COUNT(*) as a BigInt, so `0n === 0` is false and a
// strict comparison silently takes the wrong branch. Always coerce.
const count = (row) => Number(row?.n ?? 0);

async function tableExists(name) {
  const [row] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [name],
  );
  return count(row) > 0;
}

async function columnExists(table, column) {
  const [row] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return count(row) > 0;
}

// --- delivery_settings -------------------------------------------------------
if (await tableExists("delivery_settings")) {
  console.log("delivery_settings: already exists");
} else {
  // Carries the same base-entity block as every other table in this schema
  // (id/uuid/created_at/created_by/updated_at/updated_by/deleted_at) so the
  // shared ACTIVE + forCreate/forUpdate helpers work unchanged.
  await conn.query(`
    CREATE TABLE \`delivery_settings\` (
      \`id\` int NOT NULL AUTO_INCREMENT,
      \`uuid\` varchar(36) NOT NULL,
      \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      \`created_by\` int DEFAULT NULL,
      \`updated_at\` timestamp NULL DEFAULT NULL,
      \`updated_by\` int DEFAULT NULL,
      \`deleted_at\` timestamp(6) NULL DEFAULT NULL,
      \`mode\` enum('FLAT','FREE_ABOVE','PER_ORDER','PER_KM') NOT NULL DEFAULT 'PER_ORDER',
      \`flat_amount\` decimal(10,2) NOT NULL DEFAULT '0.00',
      \`free_above_amount\` decimal(10,2) NOT NULL DEFAULT '0.00',
      \`per_km_rate\` decimal(10,2) NOT NULL DEFAULT '0.00',
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  console.log("delivery_settings: created");
}

const [existing] = await conn.query(
  `SELECT COUNT(*) AS n FROM delivery_settings WHERE deleted_at IS NULL`,
);
if (count(existing) === 0) {
  // PER_ORDER is the honest default: it is what the business does today (staff
  // set each charge by hand), so it changes nothing until someone chooses a rule.
  await conn.query(
    `INSERT INTO delivery_settings (uuid, mode, flat_amount, free_above_amount, per_km_rate)
     VALUES (?, 'PER_ORDER', 0.00, 0.00, 0.00)`,
    [randomUUID()],
  );
  console.log("delivery_settings: seeded one row (mode=PER_ORDER)");
} else {
  console.log(`delivery_settings: ${count(existing)} row(s) already present`);
}

// --- user_outlets.distance_km ------------------------------------------------
if (await columnExists("user_outlets", "distance_km")) {
  console.log("user_outlets.distance_km: already exists");
} else {
  // Nullable: unknown distance must be distinguishable from zero distance, or
  // PER_KM would silently deliver free.
  await conn.query(
    `ALTER TABLE \`user_outlets\` ADD COLUMN \`distance_km\` decimal(8,2) NULL AFTER \`outlet_gstin\``,
  );
  console.log("user_outlets.distance_km: added");
}

const [outlets] = await conn.query(
  `SELECT COUNT(*) AS total, SUM(distance_km IS NULL) AS without_distance
   FROM user_outlets WHERE deleted_at IS NULL`,
);
console.log(
  `\noutlets: ${Number(outlets.total)} active, ${Number(outlets.without_distance)} without a distance yet`,
);
console.log("Run `npx prisma db pull && npx prisma generate`.");

await conn.end();
