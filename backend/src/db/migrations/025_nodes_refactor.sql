-- Migration 025: fix nodes table — add stable node_id, purge phantom Docker-hostname rows,
-- add HA invite tokens for the add-server workflow.

-- 1. Add node_id as a stable, admin-assigned identifier (separate from the UUID PK)
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS node_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS nodes_node_id_unique ON nodes (node_id) WHERE node_id IS NOT NULL;

-- 2. Purge phantom rows created by Docker-random-hostname self-registrations.
--    These have no api_url and no last_seen — they are the ghost entries.
DELETE FROM nodes WHERE (api_url IS NULL OR api_url = '') AND last_seen IS NULL;

-- 3. Invite tokens — admin generates one in the UI; new server uses it to join.
CREATE TABLE IF NOT EXISTS ha_invite_tokens (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token        VARCHAR(64) NOT NULL UNIQUE,
  label        TEXT,                               -- e.g. "Secondary - Building B"
  ha_role      VARCHAR(20) NOT NULL DEFAULT 'standby',
  created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  used_at      TIMESTAMPTZ,
  used_by_node UUID        REFERENCES nodes(id) ON DELETE SET NULL
);
