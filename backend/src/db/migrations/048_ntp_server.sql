-- ClassGuard's existing "NTP" feature only ever polled external ntp_servers
-- for dashboard health (services/ntp.js is a one-shot UDP client, no
-- listener anywhere) — it never served time to anything. This adds a real
-- NTP server (chrony), configured the same way as RADIUS/VRRP: a single-row
-- settings table read by a config generator (services/chrony.js), deployed
-- to every node the same way (unlike VRRP, chrony has no leader election —
-- every node independently serves time, so there's no per-node priority
-- concept here at all).
CREATE TABLE IF NOT EXISTS ntp_server_config (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled         BOOLEAN     NOT NULL DEFAULT false,
  upstream_pool   TEXT[]      NOT NULL DEFAULT ARRAY['0.pool.ntp.org','1.pool.ntp.org','2.pool.ntp.org','3.pool.ntp.org'],
  allowed_subnets TEXT[]      NOT NULL DEFAULT '{}',
  local_stratum   SMALLINT    NOT NULL DEFAULT 10,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed one row so the UI can always read/update it, same pattern as
-- radius_ha_config (migration 014).
INSERT INTO ntp_server_config DEFAULT VALUES ON CONFLICT DO NOTHING;
