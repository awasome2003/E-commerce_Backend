/**
 * MySQL zero-date defence.
 *
 * This database contains `0000-00-00 00:00:00` values — 59 of 67 purchase orders
 * carry them in both `po_date` and `delivery_date`, and 4 banner rows in
 * `date_to`. MySQL's non-strict mode accepted them (the same root cause as the
 * empty `products.warehouse` enum). Prisma hands them back as an Invalid Date,
 * and `res.json()` then throws "Invalid time value" while serialising — a 500
 * with no obvious cause.
 *
 * These columns are NOT NULL, so the values cannot simply be cleaned to NULL
 * without a schema change. Until that happens, sanitise on read: an unusable
 * date becomes null, which the UI already renders as "—".
 */

/** null for a missing or unusable date, otherwise the Date itself. */
export function safeDate(value) {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : value;
}

/** Returns a shallow copy with the named date fields sanitised. */
export function safeDates(row, fields) {
  const out = { ...row };
  for (const field of fields) {
    if (field in out) out[field] = safeDate(out[field]);
  }
  return out;
}
