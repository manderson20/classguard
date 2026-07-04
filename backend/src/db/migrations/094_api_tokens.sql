-- Generic shared-secret token registry for read-only external API
-- integrations that authenticate with a single static token (the
-- X-ClassGuard-Token pattern) rather than admin/teacher login — started
-- for PrintOps' IP->MAC lookup, but built as a list rather than a
-- one-off settings key so the next external integration is just another
-- row here instead of new bespoke UI.
--
-- is_active lets an admin kill a suspected-compromised token instantly
-- without discarding its label/description, independent of when they
-- get around to generating its replacement.
CREATE TABLE api_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,   -- stable slug consumer routes check against, e.g. 'printops_lookup'
  label        TEXT NOT NULL,          -- display name, e.g. "PrintOps IP -> MAC Lookup"
  description  TEXT,                   -- what it's for / who consumes it
  token        TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Token value is generated application-side (crypto.randomBytes) right
-- after this migration runs, not here — pgcrypto isn't installed on this
-- database, and gen_random_uuid() alone isn't a suitable secret generator.
INSERT INTO api_tokens (name, label, description, token, is_active)
VALUES (
  'printops_lookup',
  'PrintOps IP -> MAC Lookup',
  'Read-only GET /api/v1/lookup?ip=<ip>, used by PrintOps (print.brookfieldr3.org) to resolve a printing client''s IP to its DHCP MAC address, so it can attribute print jobs to the right person via its cached Mosyle device list.',
  '',
  false
);
