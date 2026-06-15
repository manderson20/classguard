-- Migration 007: local password auth for first-run admin setup
-- Stores scrypt hash (salt:hash) only for accounts created via the setup wizard.
-- Google-authenticated accounts leave this NULL.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
