import "dotenv/config";
import mariadb from "mariadb";
import { randomUUID } from "node:crypto";

/**
 * Adds customer product/order requests.
 *
 * What this is for
 * ----------------
 * A customer can ask for something they cannot simply add to the cart: an item
 * the catalogue does not carry, or a whole basket they want priced before it
 * becomes an order. Wholesale buying is negotiated, and today that conversation
 * happens off-platform with nothing recorded.
 *
 * Why not `ticket_system`
 * -----------------------
 * A ticket is one subject and one body. A request has *lines* — product,
 * quantity, and the price the admin agrees to — and it has to be able to become
 * an order. Neither fits in a free-text ticket, and a request that cannot convert
 * would leave someone re-keying the basket by hand, which is exactly where the
 * agreed price gets lost.
 *
 * A line names EITHER a catalogue product (`product_id`) or an item we do not
 * stock (`product_name`, free text). A CHECK constraint enforces that one of the
 * two is present; MySQL 8.0.16+ enforces CHECK, and this schema is on 8.4.
 *
 * `quoted_price` uses decimal(10,2), deliberately breaking with the float money
 * columns elsewhere — see add-delivery-settings.js for why. It is a PER-UNIT
 * price, matching `order_products.unit_price` and the pricing engine.
 *
 * Pass `--dry-run` to print what would change without writing.
 * Idempotent — safe to re-run. **Also run against the upstream RDS.**
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

// The base-entity block every table in this schema carries, so the shared ACTIVE
// and forCreate/forUpdate helpers work against these tables unchanged.
const BASE_COLUMNS = `
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`uuid\` varchar(36) NOT NULL,
  \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  \`created_by\` int DEFAULT NULL,
  \`updated_at\` timestamp NULL DEFAULT NULL,
  \`updated_by\` int DEFAULT NULL,
  \`deleted_at\` timestamp(6) NULL DEFAULT NULL,
`;

// --- product_requests --------------------------------------------------------
if (await tableExists("product_requests")) {
  console.log("product_requests: already exists");
} else if (DRY_RUN) {
  console.log("would CREATE table product_requests");
} else {
  await conn.query(`
    CREATE TABLE \`product_requests\` (
      ${BASE_COLUMNS}
      \`user_id\` int NOT NULL,
      -- Where it would be delivered. Nullable because a customer may ask about a
      -- product before deciding an outlet, but required before it can convert.
      \`outlet_id\` int DEFAULT NULL,
      \`status\` enum('Pending','Quoted','Approved','Rejected') NOT NULL DEFAULT 'Pending',
      \`note\` longtext,
      \`admin_reply\` longtext,
      -- Set when the request converts, so a request and its order are traceable
      -- in both directions and a second approval can be refused.
      \`order_id\` int DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`IDX_product_requests_user\` (\`user_id\`),
      KEY \`IDX_product_requests_status\` (\`status\`),
      CONSTRAINT \`FK_product_requests_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`),
      CONSTRAINT \`FK_product_requests_outlet\` FOREIGN KEY (\`outlet_id\`) REFERENCES \`user_outlets\` (\`id\`),
      CONSTRAINT \`FK_product_requests_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`orders\` (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  console.log("product_requests: created");
}

// --- product_request_items ---------------------------------------------------
if (await tableExists("product_request_items")) {
  console.log("product_request_items: already exists");
} else if (DRY_RUN) {
  console.log("would CREATE table product_request_items");
} else {
  await conn.query(`
    CREATE TABLE \`product_request_items\` (
      ${BASE_COLUMNS}
      \`request_id\` int NOT NULL,
      -- Exactly one of these carries the item: product_id for something we stock,
      -- product_name for something we do not.
      \`product_id\` int DEFAULT NULL,
      \`product_name\` varchar(255) DEFAULT NULL,
      \`quantity\` int NOT NULL,
      -- Per-unit, like order_products.unit_price. NULL until an admin quotes.
      \`quoted_price\` decimal(10,2) DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`IDX_product_request_items_request\` (\`request_id\`),
      CONSTRAINT \`FK_product_request_items_request\` FOREIGN KEY (\`request_id\`)
        REFERENCES \`product_requests\` (\`id\`) ON DELETE CASCADE,
      CONSTRAINT \`FK_product_request_items_product\` FOREIGN KEY (\`product_id\`)
        REFERENCES \`products\` (\`id\`),
      CONSTRAINT \`CHK_product_request_items_item\`
        CHECK (\`product_id\` IS NOT NULL OR \`product_name\` IS NOT NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  console.log("product_request_items: created");
}

// --- the Requests module -----------------------------------------------------
// Staff-side access is governed by the matrix like every other module. Customers
// reach their own requests through Storefront instead, so this module is never
// granted to the Customer role.
const MODULE_TITLE = "Requests";

const [moduleRow] = await conn.query(
  `SELECT id FROM master_module WHERE title = ? AND deleted_at IS NULL LIMIT 1`,
  [MODULE_TITLE],
);

let moduleId = moduleRow?.id ?? null;

if (moduleId) {
  console.log(`module '${MODULE_TITLE}': already exists (id=${moduleId})`);
} else if (DRY_RUN) {
  console.log(`would CREATE module '${MODULE_TITLE}'`);
} else {
  const res = await conn.query(`INSERT INTO master_module (uuid, title) VALUES (?, ?)`, [
    randomUUID(),
    MODULE_TITLE,
  ]);
  moduleId = Number(res.insertId);
  console.log(`module '${MODULE_TITLE}': created (id=${moduleId})`);
}

// Granted to whoever already manages Orders — a request becomes an order, so the
// same people handle both. Chosen from data rather than hardcoding role ids,
// which differ between this database and RDS.
// On a dry run the module does not exist yet, so there is no id to check
// permissions against — the roles are still listed, or the preview would hide
// the half of this migration that changes who can see what.
if (moduleId || DRY_RUN) {
  const roles = await conn.query(
    `SELECT DISTINCT r.id, r.title
       FROM master_roles r
       JOIN master_role_permissions p ON p.role_id = r.id AND p.deleted_at IS NULL
       JOIN master_module m ON m.id = p.module_id AND m.deleted_at IS NULL
      WHERE r.deleted_at IS NULL AND m.title = 'Orders' AND p.read = 1`,
  );

  for (const role of roles) {
    const [existing] = moduleId
      ? await conn.query(
          `SELECT COUNT(*) AS n FROM master_role_permissions
            WHERE role_id = ? AND module_id = ? AND deleted_at IS NULL`,
          [role.id, moduleId],
        )
      : [{ n: 0 }];

    if (count(existing) > 0) {
      console.log(`role ${role.id} (${role.title}): already holds ${MODULE_TITLE}`);
    } else if (DRY_RUN) {
      console.log(`role ${role.id} (${role.title}): would GRANT ${MODULE_TITLE}`);
    } else {
      await conn.query(
        `INSERT INTO master_role_permissions
           (uuid, role_id, module_id, \`create\`, \`read\`, \`update\`, \`delete\`)
         VALUES (?, ?, ?, 1, 1, 1, 1)`,
        [randomUUID(), role.id, moduleId],
      );
      console.log(`role ${role.id} (${role.title}): ${MODULE_TITLE} granted`);
    }
  }

  if (roles.length === 0) {
    console.log("no role holds Orders read — nothing to grant. Grant Requests by hand.");
  }
}

console.log("\nRun `npx prisma db pull && npx prisma generate`.");

await conn.end();
