import { prisma } from "../lib/prisma.js";
import { ACTIVE } from "../lib/records.js";

/**
 * Notifications — read-only.
 *
 * Admin holds `read` on this module and nothing else in the permission matrix,
 * so there is deliberately no create/update/delete here.
 *
 * The data is duplicated at source. The schema intends one row in
 * `notifications` (the message) plus one row per recipient in
 * `notification_user` (read state) — but the legacy app writes a whole message
 * row per admin recipient. With 28 admins one order produces ~30 near-identical
 * rows: 1,891 messages for 159 orders, averaging 11.5 per order and peaking at 30.
 *
 * Listing them raw would be unreadable, so identical messages for the same order
 * are collapsed into one entry carrying a `duplicates` count. The underlying rows
 * are left untouched — this is a display fix, not a data migration.
 */

export async function listNotifications(req, res, next) {
  try {
    const { search = "", is_admin, page = "1", limit = "25" } = req.query;

    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);

    const where = {
      ...ACTIVE,
      ...(search
        ? { OR: [{ title: { contains: search } }, { message: { contains: search } }] }
        : {}),
      ...(is_admin !== undefined && is_admin !== "" ? { is_admin: Number(is_admin) } : {}),
    };

    // Collapsing happens after the fetch, so paging is applied to the grouped
    // result rather than the raw rows — otherwise a page could be mostly dupes.
    const rows = await prisma.notifications.findMany({
      where,
      select: {
        id: true,
        title: true,
        message: true,
        order_id: true,
        is_admin: true,
        created_at: true,
        _count: { select: { notification_user: true } },
      },
      orderBy: { created_at: "desc" },
    });

    const groups = new Map();
    for (const row of rows) {
      // Same message + same order on the same day is the duplication signature.
      const day = row.created_at.toISOString().slice(0, 10);
      const key = `${row.order_id ?? "none"}|${row.title}|${row.message}|${day}`;
      const existing = groups.get(key);
      if (existing) {
        existing.duplicates += 1;
        existing.recipients += row._count.notification_user;
        existing.duplicate_ids.push(row.id);
        if (row.created_at > existing.created_at) existing.created_at = row.created_at;
      } else {
        groups.set(key, {
          id: row.id,
          title: row.title,
          message: row.message,
          order_id: row.order_id,
          is_admin: row.is_admin === 1,
          created_at: row.created_at,
          recipients: row._count.notification_user,
          duplicates: 1,
          duplicate_ids: [row.id],
        });
      }
    }

    const collapsed = [...groups.values()];
    const total = collapsed.length;
    const items = collapsed.slice((currentPage - 1) * take, currentPage * take);

    res.json({
      items,
      total,
      page: currentPage,
      limit: take,
      pages: Math.ceil(total / take),
      raw_total: rows.length,
    });
  } catch (err) {
    next(err);
  }
}
