-- Migration 028: Multicast groups, subnet utilization alert thresholds, ping-scan opt-out

-- -------------------------------------------------------------------------
-- Multicast groups (e.g. VoIP paging zones, IPTV, IoT discovery)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS multicast_groups (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  group_address INET         NOT NULL,
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  vlan_id       UUID         REFERENCES vlans(id) ON DELETE SET NULL,
  location_id   UUID         REFERENCES locations(id) ON DELETE SET NULL,
  application   VARCHAR(50)  DEFAULT 'other',  -- voip_paging | video | iot | other
  port          INT,
  is_active     BOOLEAN      DEFAULT true,
  notes         TEXT,
  created_by    UUID         REFERENCES users(id),
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT multicast_group_address_range CHECK (
    group_address <<= '224.0.0.0/4'::inet OR group_address <<= 'ff00::/8'::inet
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_multicast_group_address ON multicast_groups(group_address);
CREATE INDEX IF NOT EXISTS idx_multicast_vlan     ON multicast_groups(vlan_id);
CREATE INDEX IF NOT EXISTS idx_multicast_location ON multicast_groups(location_id);

-- -------------------------------------------------------------------------
-- Utilization alert threshold + ping-scan opt-out, per subnet
-- -------------------------------------------------------------------------
ALTER TABLE ipam_subnets
  ADD COLUMN IF NOT EXISTS alert_threshold_pct SMALLINT DEFAULT 90 CHECK (alert_threshold_pct BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS scan_enabled         BOOLEAN  DEFAULT true;
