import { prisma } from "../lib/prisma.js";
import { ACTIVE, forUpdate } from "../lib/records.js";

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

/**
 * The signed-in customer's own notifications.
 *
 * Unlike the admin view, these are read through `notification_user` (one row per
 * recipient, carrying `is_read`) scoped to `req.user.id` — so a customer only
 * ever sees notifications addressed to them. The `id` returned is the
 * notification_user row id, which is what "mark read" acts on.
 */
export async function listMyNotifications(req, res, next) {
  try {
    const rows = await prisma.notification_user.findMany({
      where: { user_id: req.user.id, ...ACTIVE, notifications: { ...ACTIVE } },
      select: {
        id: true,
        is_read: true,
        created_at: true,
        notifications: { select: { title: true, message: true, order_id: true } },
      },
      orderBy: { created_at: "desc" },
      take: 100,
    });

    const items = rows.map((r) => ({
      id: r.id,
      title: r.notifications?.title ?? "",
      message: r.notifications?.message ?? "",
      order_id: r.notifications?.order_id ?? null,
      is_read: r.is_read === 1,
      created_at: r.created_at,
    }));

    res.json({ items, unread: items.filter((i) => !i.is_read).length });
  } catch (err) {
    next(err);
  }
}

/** Marks all of the customer's unread notifications as read. */
export async function markMyNotificationsRead(req, res, next) {
  try {
    await prisma.notification_user.updateMany({
      where: { user_id: req.user.id, is_read: 0, ...ACTIVE },
      data: forUpdate(req.user.id, { is_read: 1 }),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

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
