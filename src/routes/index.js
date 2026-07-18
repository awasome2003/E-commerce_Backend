import { Router } from "express";
import { requireAuth, requireCustomer } from "../middleware/auth.js";
import { requirePermission, requireStaff, MODULES } from "../middleware/rbac.js";

import { login, customerLogin, register, me } from "../controllers/auth.controller.js";
import {
  getSettings as getDeliveryConfig,
  updateSettings as updateDeliveryConfig,
  previewDelivery,
  updateOutletDistance,
} from "../controllers/delivery.controller.js";
import {
  listShopFilters,
  listShopProducts,
  getShopProduct,
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  listMyOutlets,
  createOutlet,
  quoteCheckout,
  checkout,
  listMyOrders,
  getMyOrder,
} from "../controllers/shop.controller.js";
import { getDashboard } from "../controllers/dashboard.controller.js";
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/product.controller.js";
import {
  listCategories,
  listSubCategories,
  listBrands,
  listManufacturers,
  listCustomerCategories,
  listRoles,
} from "../controllers/master.controller.js";
import {
  listOrders,
  getOrder,
  updateOrderStatus,
  updateOrderPayment,
} from "../controllers/order.controller.js";
import {
  listCustomers,
  getCustomer,
  getCustomerPricing,
  updateCustomer,
} from "../controllers/customer.controller.js";
import {
  listTickets,
  getTicket,
  addMessage,
  updateTicketStatus,
  listTicketStatuses,
  listTicketCategories,
} from "../controllers/ticket.controller.js";
import {
  listCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  deleteCoupon,
} from "../controllers/coupon.controller.js";
import {
  listBanners,
  getBanner,
  createBanner,
  updateBanner,
  deleteBanner,
} from "../controllers/banner.controller.js";
import {
  getPermissionMatrix,
  updatePermissions,
  listRolesWithCounts,
  createRole,
  updateRole,
  deleteRole,
} from "../controllers/settings.controller.js";
import { previewPrice } from "../controllers/pricing.controller.js";
import { listNotifications } from "../controllers/notification.controller.js";
import {
  listPurchaseOrders,
  getPurchaseOrder,
  listInvoices,
} from "../controllers/purchase-order.controller.js";

const router = Router();

router.get("/health", (req, res) => res.json({ status: "ok" }));
router.post("/auth/login", login);
// Separate door for customers — see customerLogin for why the audiences must not
// share one endpoint.
router.post("/shop/auth/login", customerLogin);
router.post("/shop/auth/register", register);

// Everything past this point requires a valid token. The catalogue included:
// prices here are negotiated per customer and are not public information.
router.use(requireAuth);

// ---------------------------------------------------- storefront (customers)
// Guarded by role, not by the module matrix: customers score zero on every
// module, so the matrix cannot express "may shop".
const shop = Router();
shop.use(requireCustomer);
shop.get("/me", (req, res) => res.json({ user: req.user }));
shop.get("/filters", listShopFilters);
shop.get("/products", listShopProducts);
shop.get("/products/:id", getShopProduct);
shop.get("/cart", getCart);
shop.post("/cart", addToCart);
shop.put("/cart/:id", updateCartItem);
shop.delete("/cart/:id", removeCartItem);
shop.get("/outlets", listMyOutlets);
shop.post("/outlets", createOutlet);
shop.get("/checkout/quote", quoteCheckout);
shop.post("/checkout", checkout);
shop.get("/orders", listMyOrders);
shop.get("/orders/:id", getMyOrder);
router.use("/shop", shop);

router.get("/auth/me", me);
// Spans several modules, so it has no single permission to sit behind — but it
// must still be staff-only: it exposes revenue, customer counts and recent orders.
router.get("/dashboard", requireStaff, getDashboard);

const products = Router();
products.get("/", requirePermission(MODULES.PRODUCTS, "read"), listProducts);
// Must precede "/:id", or Express matches this literal path as a product id.
products.get("/price-preview", requirePermission(MODULES.PRODUCTS, "read"), previewPrice);
products.get("/:id", requirePermission(MODULES.PRODUCTS, "read"), getProduct);
products.post("/", requirePermission(MODULES.PRODUCTS, "create"), createProduct);
products.put("/:id", requirePermission(MODULES.PRODUCTS, "update"), updateProduct);
products.delete("/:id", requirePermission(MODULES.PRODUCTS, "delete"), deleteProduct);
router.use("/products", products);

const orders = Router();
orders.get("/", requirePermission(MODULES.ORDERS, "read"), listOrders);
orders.get("/:id", requirePermission(MODULES.ORDERS, "read"), getOrder);
orders.patch("/:id/status", requirePermission(MODULES.ORDERS, "update"), updateOrderStatus);
orders.patch("/:id/payment", requirePermission(MODULES.ORDERS, "update"), updateOrderPayment);
router.use("/orders", orders);

// Delivery configuration lives under Settings; the per-outlet distance it
// depends on is customer data, so that one sits under Customers.
const settingsDelivery = Router();
settingsDelivery.get("/", requirePermission(MODULES.SETTINGS, "read"), getDeliveryConfig);
settingsDelivery.put("/", requirePermission(MODULES.SETTINGS, "update"), updateDeliveryConfig);
settingsDelivery.get("/preview", requirePermission(MODULES.SETTINGS, "read"), previewDelivery);
router.use("/delivery-settings", settingsDelivery);

const customers = Router();
customers.patch("/outlets/:id/distance", requirePermission(MODULES.CUSTOMERS, "update"), updateOutletDistance);
customers.get("/", requirePermission(MODULES.CUSTOMERS, "read"), listCustomers);
customers.get("/:id", requirePermission(MODULES.CUSTOMERS, "read"), getCustomer);
customers.get("/:id/pricing", requirePermission(MODULES.CUSTOMERS, "read"), getCustomerPricing);
customers.put("/:id", requirePermission(MODULES.CUSTOMERS, "update"), updateCustomer);
router.use("/customers", customers);

const tickets = Router();
tickets.get("/", requirePermission(MODULES.SUPPORT, "read"), listTickets);
tickets.get("/:id", requirePermission(MODULES.SUPPORT, "read"), getTicket);
tickets.post("/:id/messages", requirePermission(MODULES.SUPPORT, "create"), addMessage);
tickets.patch("/:id/status", requirePermission(MODULES.SUPPORT, "update"), updateTicketStatus);
router.use("/tickets", tickets);

const coupons = Router();
coupons.get("/", requirePermission(MODULES.COUPON, "read"), listCoupons);
coupons.get("/:id", requirePermission(MODULES.COUPON, "read"), getCoupon);
coupons.post("/", requirePermission(MODULES.COUPON, "create"), createCoupon);
coupons.put("/:id", requirePermission(MODULES.COUPON, "update"), updateCoupon);
coupons.delete("/:id", requirePermission(MODULES.COUPON, "delete"), deleteCoupon);
router.use("/coupons", coupons);

const banners = Router();
banners.get("/", requirePermission(MODULES.BANNER_ADS, "read"), listBanners);
banners.get("/:id", requirePermission(MODULES.BANNER_ADS, "read"), getBanner);
banners.post("/", requirePermission(MODULES.BANNER_ADS, "create"), createBanner);
banners.put("/:id", requirePermission(MODULES.BANNER_ADS, "update"), updateBanner);
banners.delete("/:id", requirePermission(MODULES.BANNER_ADS, "delete"), deleteBanner);
router.use("/banners", banners);

const settings = Router();
settings.get("/permissions", requirePermission(MODULES.SETTINGS, "read"), getPermissionMatrix);
settings.put("/permissions/:roleId", requirePermission(MODULES.SETTINGS, "update"), updatePermissions);
settings.get("/roles", requirePermission(MODULES.SETTINGS, "read"), listRolesWithCounts);
settings.post("/roles", requirePermission(MODULES.SETTINGS, "create"), createRole);
settings.put("/roles/:id", requirePermission(MODULES.SETTINGS, "update"), updateRole);
settings.delete("/roles/:id", requirePermission(MODULES.SETTINGS, "delete"), deleteRole);
router.use("/settings", settings);

// Read-only: Admin holds only `read` on Notification in the permission matrix.
const notifications = Router();
notifications.get("/", requirePermission(MODULES.NOTIFICATION, "read"), listNotifications);
router.use("/notifications", notifications);

// No "Purchase Orders" module exists — these are documents belonging to an order,
// so they sit behind the Orders permission.
const documents = Router();
documents.get("/purchase-orders", requirePermission(MODULES.ORDERS, "read"), listPurchaseOrders);
documents.get("/purchase-orders/:id", requirePermission(MODULES.ORDERS, "read"), getPurchaseOrder);
documents.get("/invoices", requirePermission(MODULES.ORDERS, "read"), listInvoices);
router.use("/documents", documents);

// Lookup lists feed dropdowns across the panel, so they sit behind staff access
// rather than a per-module permission. The storefront has its own copies — a
// customer must not read the staff lists (roles, customer categories).
const masters = Router();
masters.use(requireStaff);
masters.get("/categories", listCategories);
masters.get("/sub-categories", listSubCategories);
masters.get("/brands", listBrands);
masters.get("/manufacturers", listManufacturers);
masters.get("/customer-categories", listCustomerCategories);
masters.get("/roles", listRoles);
masters.get("/ticket-statuses", listTicketStatuses);
masters.get("/ticket-categories", listTicketCategories);
router.use("/masters", masters);

export default router;
