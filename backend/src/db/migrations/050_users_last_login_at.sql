-- users.last_login_at has been referenced by extension.js (set on every
-- extension login) and analytics.js (Staff Analytics "last login" sort and
-- "active this week" calculation) for as long as those routes have
-- existed, but the column itself was never actually added — every write
-- via the extension's /auth route has been throwing
-- "column \"last_login_at\" of relation \"users\" does not exist" and
-- returning a 500, which silently broke extension authentication for every
-- student entirely (no real device has ever successfully authenticated).
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
