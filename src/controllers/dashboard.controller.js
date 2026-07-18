import { prisma } from "../lib/prisma.js";
import { ACTIVE } from "../lib/records.js";

export async function getDashboard(req, res, next) {
  try {
    const [
      productCount,
      activeProductCount,
      customerCount,
      orderCount,
      outletCount,
      openTickets,
      statusGroups,
      revenue,
      recentOrders,
    ] = await Promise.all([
      prisma.products.count({ where: ACTIVE }),
      prisma.products.count({ where: { ...ACTIVE, is_active: 1 } }),
      prisma.users.count({ where: { ...ACTIVE, master_roles: { title: "Customer" } } }),
      prisma.orders.count({ where: ACTIVE }),
      prisma.user_outlets.count({ where: ACTIVE }),
      // master_ticket_status only contains "Pending" and "status update" — there
      // is no closed/resolved state in this schema, so "open" means Pending
      // rather than "not Closed" (which would silently count every ticket).
      prisma.ticket_system.count({
        where: { ...ACTIVE, master_ticket_status: { title: "Pending" } },
      }),
      prisma.orders.groupBy({
        by: ["order_status"],
        where: ACTIVE,
        _count: { _all: true },
      }),
      prisma.orders.aggregate({
        where: ACTIVE,
        _sum: { total_order_value: true },
      }),
      prisma.orders.findMany({
        where: ACTIVE,
        select: {
          id: true,
          order_status: true,
          total_order_value: true,
          created_at: true,
          users: { select: { first_name: true, last_name: true } },
          user_outlets: { select: { outlet_name: true } },
        },
        orderBy: { created_at: "desc" },
        take: 8,
      }),
    ]);

    res.json({
      totals: {
        products: productCount,
        active_products: activeProductCount,
        customers: customerCount,
        orders: orderCount,
        outlets: outletCount,
        open_tickets: openTickets,
        revenue: revenue._sum.total_order_value ?? 0,
      },
      orders_by_status: statusGroups.map((g) => ({
        status: g.order_status,
        count: g._count._all,
      })),
      recent_orders: recentOrders,
    });
  } catch (err) {
    next(err);
  }
}
