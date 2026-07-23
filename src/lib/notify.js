import { randomUUID } from "node:crypto";
import { forCreate } from "./records.js";

/**
 * Create a notification addressed to ONE customer.
 *
 * The schema intends one `notifications` row (the message) plus one
 * `notification_user` row per recipient (carrying read state). A customer
 * notification therefore is one message with a single recipient row.
 *
 * `is_admin` is 0 so it is a customer-facing message; the customer read endpoint
 * (`/shop/notifications`) surfaces it via the recipient row.
 *
 * Pass the caller's transaction client as `tx` so the notification commits with
 * the action that triggered it — a status change and its notification are
 * all-or-nothing.
 *
 * @param {object} tx      Prisma transaction client (or the base client)
 * @param {object} args
 * @param {number} args.actorId  who triggered it (for created_by/updated_by)
 * @param {number} args.userId   the customer who receives it
 * @param {string} args.title
 * @param {string} args.message
 * @param {number} [args.orderId]
 */
export async function notifyCustomer(tx, { actorId, userId, title, message, orderId = null }) {
  const notification = await tx.notifications.create({
    data: forCreate(actorId ?? null, { title, message, order_id: orderId, is_admin: 0 }),
    select: { id: true },
  });
  await tx.notification_user.create({
    data: {
      uuid: randomUUID(),
      created_by: actorId ?? null,
      user_id: userId,
      notification_id: notification.id,
      is_read: 0,
    },
  });
  return notification.id;
}
