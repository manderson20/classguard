-- Migration 010: HA management extensions + NTP monitoring

-- -------------------------------------------------------------------------
-- Extend nodes table with HA role and sync metadata
-- -------------------------------------------------------------------------
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS ha_role       VARCHAR(20)  DEFAULT 'primary',
  -- ha_role: primary | standby | replica
  ADD COLUMN IF NOT EXISTS api_url       VARCHAR(500),
  ADD COLUMN IF NOT EXISTS last_seen     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS db_lag_bytes  BIGINT,
  ADD COLUMN IF NOT EXISTS version       VARCHAR(50);

-- -------------------------------------------------------------------------
-- NTP server configuration
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ntp_servers (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  address     VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  is_active   BOOLEAN      DEFAULT true,
  prefer      BOOLEAN      DEFAULT false,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Seed with sensible defaults
INSERT INTO ntp_servers (address, description, is_active)
VALUES
  ('time.cloudflare.com', 'Cloudflare NTP', true),
  ('time.google.com',     'Google NTP',     true)
ON CONFLICT (address) DO NOTHING;

-- -------------------------------------------------------------------------
-- NTP peer status (polled on demand, last result cached here)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ntp_peer_status (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    UUID         REFERENCES ntp_servers(id) ON DELETE CASCADE,
  address      VARCHAR(255) NOT NULL,
  stratum      INT,
  offset_ms    FLOAT,
  delay_ms     FLOAT,
  jitter_ms    FLOAT,
  reachable    BOOLEAN      DEFAULT false,
  reference    VARCHAR(255),   -- reference clock ID (e.g. GPS, PPS, or upstream IP)
  poll_interval INT,
  checked_at   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(server_id)
);
