import { prisma } from "../lib/prisma.js";
import { ACTIVE } from "../lib/records.js";
import { safeDates } from "../lib/dates.js";

/** 59 of 67 purchase orders store 0000-00-00 in both date columns. */
const PO_DATES = ["po_date", "delivery_date", "created_at", "updated_at", "deleted_at"];
const INVOICE_DATES = ["invoice_date", "due_date", "created_at", "updated_at", "deleted_at"];

/**
 * Purchase orders and GST invoices — read-only.
 *
 * There is no "Purchase Orders" module in `master_module`, so these sit behind
 * the Orders permission: they are documents belonging to an order.
 *
 * Both are generated documents (67 POs, 79 invoices, every invoice carrying a
 * PDF url) with bill-to/ship-to, GSTIN and totals frozen at issue time. They
 * duplicate order data on purpose — an issued document must not change when the
 * order or the customer's details later do. Nothing here edits them; regenerating
 * a document is a different job from viewing one.
 *
 * `purchase_order.products` and `order_invoice.products` are longtext holding a
 * serialised snapshot of the lines. It is passed through untouched rather than
 * parsed — the format is unverified and guessing at it would be worse than
 * showing nothing.
 */

export async function listPurchaseOrders(req, res, next) {
  try {
    const { search = "", page = "1", limit = "25" } = req.query;

    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * take;

    const where = {
      ...ACTIVE,
      ...(search
        ? {
            OR: [
              { po_number: { contains: search } },
              { bill_to_name: { contains: search } },
              { ship_to_name: { contains: search } },
              { bill_to_gstin: { contains: search } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.purchase_order.findMany({
        where,
        select: {
          id: true,
          po_number: true,
          po_date: true,
          delivery_date: true,
          bill_to_name: true,
          ship_to_name: true,
          ship_to_state: true,
          bill_to_gstin: true,
          sub_total: true,
          delivery_charge: true,
          discount: true,
          final_amount: true,
          receipt_url: true,
          order_id: true,
        },
        orderBy: { po_date: "desc" },
        take,
        skip,
      }),
      prisma.purchase_order.count({ where }),
    ]);

    res.json({
      items: items.map((po) => safeDates(po, PO_DATES)),
      total,
      page: currentPage,
      limit: take,
      pages: Math.ceil(total / take),
    });
  } catch (err) {
    next(err);
  }
}

export async function getPurchaseOrder(req, res, next) {
  try {
    const po = await prisma.purchase_order.findFirst({
      where: { id: Number(req.params.id), ...ACTIVE },
    });
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    res.json(safeDates(po, PO_DATES));
  } catch (err) {
    next(err);
  }
}

export async function listInvoices(req, res, next) {
  try {
    const { search = "", page = "1", limit = "25" } = req.query;

    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * take;

    const where = {
      ...ACTIVE,
      ...(search
        ? {
            OR: [
              { customer_name: { contains: search } },
              { outlet_name: { contains: search } },
              { gst_number: { contains: search } },
              { billing_name: { contains: search } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.order_invoice.findMany({
        where,
        select: {
          id: true,
          invoice_number: true,
          invoice_date: true,
          due_date: true,
          order_number: true,
          customer_name: true,
          outlet_name: true,
          gst_number: true,
          sub_total: true,
          discount: true,
          credits_used: true,
          final_amount: true,
          invoice_url: true,
          order_id: true,
        },
        orderBy: { invoice_date: "desc" },
        take,
        skip,
      }),
      prisma.order_invoice.count({ where }),
    ]);

    // Invoices are clean today, but they come from the same non-strict server
    // that produced the zero-dates in purchase_order — guard them the same way.
    res.json({
      items: items.map((inv) => safeDates(inv, INVOICE_DATES)),
      total,
      page: currentPage,
      limit: take,
      pages: Math.ceil(total / take),
    });
  } catch (err) {
    next(err);
  }
}
