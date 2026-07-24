import express from "express";
import cors from "cors";
import helmet from "helmet";
import routes from "./routes/index.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";

const app = express();

// Security headers. This is a JSON API (no HTML/cookies), so the defaults are a
// good fit; CORS is handled separately below for the browser clients.
app.use(helmet());

// Behind Railway/Vercel's proxy, the client IP is in X-Forwarded-For. Trust one
// hop so the rate limiter keys on the real IP, not the proxy.
app.set("trust proxy", 1);

// CLIENT_URL may list several browser origins (comma-separated) — the web
// storefront/admin, and the Flutter *web* build used for development. Native
// mobile clients send no Origin header and are always allowed; CORS is a
// browser-only mechanism and does not apply to them.
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Outside production, accept any loopback port. Vite silently moves to 5174,
// 5175, ... whenever the previous port is still held by an old dev server, and
// a fixed allowlist turns that into an opaque 500 on every request.
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function isAllowed(origin) {
  if (allowedOrigins.includes(origin)) return true;
  return !IS_PRODUCTION && LOOPBACK.test(origin);
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowed(origin)) return callback(null, true);
      // 403, not a bare Error (which the handler would turn into a 500).
      const err = new Error(`Origin ${origin} is not allowed by CORS`);
      err.status = 403;
      callback(err);
    },
  }),
);
app.use(express.json());

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

export default app;
