import rateLimit from "express-rate-limit";

/**
 * Throttles sign-in / registration to blunt credential brute-forcing and signup
 * spam. Keyed per IP (see `trust proxy` in app.js so this is the real client IP
 * behind Railway/Vercel, not the proxy).
 *
 * Deliberately generous so a real person fat-fingering a password a few times is
 * never locked out; it only bites automated bursts.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // per IP per window
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many attempts. Please wait a few minutes and try again." },
});
