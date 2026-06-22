-- Direct-IP browsing detection/blocking. dns-engine structurally can't see
-- this (no DNS query ever happens for a literal-IP navigation) — detection
-- and optional enforcement both live in the Chrome extension. See
-- chrome-extension/src/lib/directIp.js and routes/extension.js's /tab-event.
ALTER TABLE browser_history ADD COLUMN IF NOT EXISTS is_direct_ip BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE policies        ADD COLUMN IF NOT EXISTS block_direct_ip BOOLEAN NOT NULL DEFAULT false;
