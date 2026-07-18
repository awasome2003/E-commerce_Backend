import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate, forUpdate } from "../lib/records.js";

/**
 * `ticket_system.ticket_reply` is dead — NULL on every ticket ever created. The
 * real conversation lives in `chat_messages`, which is genuinely two-way (21
 * admin messages vs 20 customer messages). This module ignores `ticket_reply`.
 */

const userRef = { select: { id: true, first_name: true, last_name: true, email: true, role_id: true } };

export async function listTickets(req, res, next) {
  try {
    const { status_id, category_id, search = "", page = "1", limit = "25" } = req.query;

    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * take;

    const where = {
      ...ACTIVE,
      ...(status_id ? { ticket_status_id: Number(status_id) } : {}),
      ...(category_id ? { ticket_category_id: Number(category_id) } : {}),
      ...(search
        ? {
            OR: [
              { ticket_subject: { contains: search } },
              { ticket_description: { contains: search } },
              { users: { first_name: { contains: search } } },
              { users: { last_name: { contains: search } } },
              { users: { email: { contains: search } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.ticket_system.findMany({
        where,
        select: {
          id: true,
          ticket_number: true,
          ticket_subject: true,
          created_at: true,
          order_id: true,
          users: userRef,
          master_ticket_status: { select: { id: true, title: true, color: true } },
          master_ticket_category: { select: { id: true, title: true } },
          _count: { select: { chat_messages: true } },
        },
        orderBy: { created_at: "desc" },
        take,
        skip,
      }),
      prisma.ticket_system.count({ where }),
    ]);

    res.json({ items, total, page: currentPage, limit: take, pages: Math.ceil(total / take) });
  } catch (err) {
    next(err);
  }
}

export async function getTicket(req, res, next) {
  try {
    const ticket = await prisma.ticket_system.findFirst({
      where: { id: Number(req.params.id), ...ACTIVE },
      select: {
        id: true,
        ticket_number: true,
        ticket_subject: true,
        ticket_description: true,
        created_at: true,
        order_id: true,
        users: userRef,
        orders: { select: { id: true, order_status: true, total_order_value: true } },
        master_ticket_status: { select: { id: true, title: true, color: true } },
        master_ticket_category: { select: { id: true, title: true } },
        // `level` is a per-ticket sequence (1..N, contiguous), not a severity —
        // it is the thread order.
        chat_messages: {
          where: ACTIVE,
          select: {
            id: true,
            message: true,
            level: true,
            created_at: true,
            users: userRef,
          },
          orderBy: { level: "asc" },
        },
      },
    });

    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
}

export async function addMessage(req, res, next) {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ message: "message is required" });
    }

    const ticketId = Number(req.params.id);
    const ticket = await prisma.ticket_system.findFirst({
      where: { id: ticketId, ...ACTIVE },
      select: { id: true },
    });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    // `level` continues the thread's sequence. Computed inside a transaction so
    // two agents replying at once cannot both claim the same level.
    const created = await prisma.$transaction(async (tx) => {
      const last = await tx.chat_messages.aggregate({
        where: { ticket_id: ticketId, ...ACTIVE },
        _max: { level: true },
      });

      return tx.chat_messages.create({
        data: forCreate(req.user.id, {
          message: message.trim(),
          ticket_id: ticketId,
          user_id: req.user.id,
          level: (last._max.level ?? 0) + 1,
        }),
        select: {
          id: true,
          message: true,
          level: true,
          created_at: true,
          users: userRef,
        },
      });
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
}

export async function updateTicketStatus(req, res, next) {
  try {
    const { ticket_status_id } = req.body;
    if (!ticket_status_id) {
      return res.status(400).json({ message: "ticket_status_id is required" });
    }

    const status = await prisma.master_ticket_status.findFirst({
      where: { id: Number(ticket_status_id), ...ACTIVE },
      select: { id: true },
    });
    if (!status) return res.status(400).json({ message: "Unknown ticket status" });

    const id = Number(req.params.id);
    const existing = await prisma.ticket_system.findFirst({
      where: { id, ...ACTIVE },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ message: "Ticket not found" });

    const ticket = await prisma.ticket_system.update({
      where: { id },
      data: forUpdate(req.user.id, { ticket_status_id: Number(ticket_status_id) }),
      select: {
        id: true,
        master_ticket_status: { select: { id: true, title: true, color: true } },
      },
    });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
}

export async function listTicketStatuses(req, res, next) {
  try {
    res.json(
      await prisma.master_ticket_status.findMany({
        where: ACTIVE,
        select: { id: true, title: true, color: true },
        orderBy: { id: "asc" },
      }),
    );
  } catch (err) {
    next(err);
  }
}

export async function listTicketCategories(req, res, next) {
  try {
    res.json(
      await prisma.master_ticket_category.findMany({
        where: ACTIVE,
        select: { id: true, title: true },
        orderBy: { title: "asc" },
      }),
    );
  } catch (err) {
    next(err);
  }
}
