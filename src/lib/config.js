/**
 * Validates critical configuration at boot.
 *
 * The point is to fail *loudly at startup* rather than silently in production:
 * a missing DATABASE_URL or a placeholder JWT secret should stop the deploy, not
 * surface as a 500 (or a security hole) once real traffic arrives.
 */

const DEV_SECRETS = new Set([
  "dev-only-secret-change-me",
  "secret",
  "changeme",
  "your-secret-here",
]);

export function validateConfig() {
  const isProd = process.env.NODE_ENV === "production";
  const errors = [];
  const warnings = [];

  // DATABASE_URL — required everywhere.
  if (!process.env.DATABASE_URL) {
    errors.push("DATABASE_URL is not set.");
  }

  // JWT secret — must be strong in production.
  const secret = process.env.JWT_SECRET || "";
  if (!secret) {
    errors.push("JWT_SECRET is not set.");
  } else if (DEV_SECRETS.has(secret) || secret.length < 32) {
    const msg =
      "JWT_SECRET is weak or a known placeholder. Generate a real one, e.g. " +
      "`node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"`.";
    if (isProd) errors.push(msg);
    else warnings.push(msg + " (allowed in development)");
  }

  // CORS origins — in production, an explicit CLIENT_URL is expected (the
  // loopback exemption in app.js only applies outside production).
  if (isProd && !process.env.CLIENT_URL) {
    warnings.push(
      "CLIENT_URL is not set in production — the browser storefront/admin origin(s) must be listed or CORS will block them.",
    );
  }

  for (const w of warnings) console.warn(`[config] WARNING: ${w}`);

  if (errors.length) {
    console.error("[config] Refusing to start due to invalid configuration:");
    for (const e of errors) console.error(`  - ${e}`);
    // Exit rather than listen — a misconfigured server must not accept traffic.
    process.exit(1);
  }
}
