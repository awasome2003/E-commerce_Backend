import { randomUUID } from "node:crypto";

/**
 * Every table in this schema carries the same TypeORM base-entity block:
 *   id, uuid, created_at, created_by, updated_at, updated_by, deleted_at
 *
 * Two consequences the helpers below exist to enforce:
 *  - `uuid` is NOT NULL with no database default, so every insert must supply one.
 *  - Deletes are soft (`deleted_at`), so every read must exclude deleted rows.
 */

/** Spread into any `where` to exclude soft-deleted rows. */
export const ACTIVE = { deleted_at: null };

/** Build the audit fields for an insert. */
export function forCreate(userId, data) {
  return { ...data, uuid: randomUUID(), created_by: userId ?? null };
}

/** Build the audit fields for an update. */
export function forUpdate(userId, data) {
  return { ...data, updated_at: new Date(), updated_by: userId ?? null };
}

/** Build the audit fields for a soft delete. */
export function forSoftDelete(userId) {
  return { deleted_at: new Date(), updated_at: new Date(), updated_by: userId ?? null };
}
