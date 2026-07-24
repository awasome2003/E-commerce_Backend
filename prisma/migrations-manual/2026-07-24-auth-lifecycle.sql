-- Tier 1 auth-lifecycle migration (token revocation, logout, change-password, lockout).
-- Additive and safe: existing rows default to 0 / NULL. Idempotency is not built in,
-- so run once; re-running errors with "Duplicate column name" (which is harmless).
--
-- Apply to production RDS BEFORE deploying the backend that reads these columns.

ALTER TABLE users
  ADD COLUMN token_version INT NOT NULL DEFAULT 0,
  ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN locked_until TIMESTAMP(6) NULL DEFAULT NULL;

-- Verify (should return 3):
-- SELECT COUNT(*) FROM information_schema.columns
--  WHERE table_schema = DATABASE() AND table_name = 'users'
--    AND column_name IN ('token_version','failed_login_attempts','locked_until');
