-- Migration 014: RADIUS / NAC (Network Access Control)
-- FreeRADIUS integration with Google Secure LDAP, MAB device control,
-- VRRP HA config, and full auth logging.

-- ---------------------------------------------------------------------------
-- NAS clients (switches, APs that send RADIUS auth requests)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radius_nas (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  shortname     TEXT        NOT NULL,
  ip_address    INET        NOT NULL UNIQUE,
  shared_secret TEXT        NOT NULL,
  vendor        TEXT        NOT NULL DEFAULT 'other',  -- unifi, meraki, aruba, ruckus, cisco, other
  description   TEXT,
  default_vlan  INTEGER,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Device NAC table — every known MAC and its access status
-- Status: approved = allow on network, blocked = always reject, pending = seen but unreviewed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radius_devices (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mac_address      MACADDR     NOT NULL UNIQUE,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('approved','blocked','pending')),
  device_name      TEXT,
  device_type      TEXT        DEFAULT 'other'
                               CHECK (device_type IN ('laptop','desktop','phone','tablet',
                                      'chromebook','printer','tv','ap','switch','server','other')),
  assigned_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  assigned_vlan    INTEGER,
  source           TEXT        NOT NULL DEFAULT 'manual'
                               CHECK (source IN ('manual','mosyle','snipeit','google_admin',
                                                 'network_controller','radius_seen')),
  source_device_id TEXT,
  notes            TEXT,
  last_seen        TIMESTAMPTZ,
  last_auth_at     TIMESTAMPTZ,
  last_auth_result TEXT        CHECK (last_auth_result IN ('accepted','rejected',NULL)),
  added_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_radius_devices_status  ON radius_devices(status);
CREATE INDEX IF NOT EXISTS idx_radius_devices_source  ON radius_devices(source);
CREATE INDEX IF NOT EXISTS idx_radius_devices_user    ON radius_devices(assigned_user_id);

-- ---------------------------------------------------------------------------
-- Per-user / per-group WiFi access policies
-- Controls which SSID a user/group can access and which VLAN they land in
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radius_user_policies (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID    REFERENCES users(id) ON DELETE CASCADE,
  group_id    UUID    REFERENCES groups(id) ON DELETE CASCADE,
  ssid        TEXT,        -- NULL = applies to all SSIDs
  vlan        INTEGER,     -- VLAN to assign; NULL = NAS default
  can_access  BOOLEAN NOT NULL DEFAULT true,
  priority    INTEGER NOT NULL DEFAULT 0,  -- higher = evaluated first
  notes       TEXT,
  CONSTRAINT chk_user_or_group CHECK (user_id IS NOT NULL OR group_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Active RADIUS sessions (populated by accounting Start/Update/Stop)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radius_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  acct_session_id TEXT      UNIQUE NOT NULL,
  username      TEXT,
  mac_address   MACADDR,
  ip_address    INET,
  nas_ip        INET,
  nas_id        TEXT,
  ssid          TEXT,
  ap_mac        TEXT,
  vlan          INTEGER,
  auth_type     TEXT,       -- mab, eap-ttls, eap-tls
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_update   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bytes_in      BIGINT      NOT NULL DEFAULT 0,
  bytes_out     BIGINT      NOT NULL DEFAULT 0,
  is_active     BOOLEAN     NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_radius_sessions_active ON radius_sessions(is_active, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_radius_sessions_mac    ON radius_sessions(mac_address);

-- ---------------------------------------------------------------------------
-- Auth log — every accept/reject, partitioned by day
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radius_auth_log (
  id            BIGSERIAL   PRIMARY KEY,
  username      TEXT,
  mac_address   MACADDR,
  nas_ip        INET,
  ssid          TEXT,
  result        TEXT        NOT NULL CHECK (result IN ('accepted','rejected')),
  reject_reason TEXT,
  auth_type     TEXT,       -- mab, eap-ttls, eap-tls
  vlan_assigned INTEGER,
  logged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_radius_log_time   ON radius_auth_log(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_radius_log_mac    ON radius_auth_log(mac_address);
CREATE INDEX IF NOT EXISTS idx_radius_log_result ON radius_auth_log(result, logged_at DESC);

-- ---------------------------------------------------------------------------
-- Per-device source tracking — one row per (device × source)
-- Allows a device to appear in multiple systems (Snipe-IT + Google Admin + Mosyle)
-- and tracks when it is removed from any source so we can deprovision it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radius_device_sources (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id        UUID        NOT NULL REFERENCES radius_devices(id) ON DELETE CASCADE,
  source           TEXT        NOT NULL,
  source_device_id TEXT,
  source_name      TEXT,       -- device name/label in the source system
  source_extra     JSONB,      -- serial, model, OS, annotatedUser, etc.
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at       TIMESTAMPTZ,        -- set when source no longer reports this device
  UNIQUE (device_id, source)
);

CREATE INDEX IF NOT EXISTS idx_rds_device  ON radius_device_sources(device_id);
CREATE INDEX IF NOT EXISTS idx_rds_source  ON radius_device_sources(source, is_active);

-- ---------------------------------------------------------------------------
-- VRRP / Keepalived HA config (single-row settings table for the VIP config)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radius_ha_config (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vip_address              INET,
  vip_prefix_len           SMALLINT    NOT NULL DEFAULT 24,
  vip_interface            TEXT        NOT NULL DEFAULT 'eth0',
  vrrp_instance_name       TEXT        NOT NULL DEFAULT 'CLASSGUARD_APPS',
  vrrp_virtual_router_id   SMALLINT    NOT NULL DEFAULT 51,
  vrrp_auth_password       TEXT,
  vrrp_advert_int          SMALLINT    NOT NULL DEFAULT 1,
  priority_primary         SMALLINT    NOT NULL DEFAULT 150,
  priority_secondary       SMALLINT    NOT NULL DEFAULT 100,
  track_freeradius         BOOLEAN     NOT NULL DEFAULT true,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed one row so the UI can always read/update it
INSERT INTO radius_ha_config DEFAULT VALUES ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Settings keys for LDAP / Google Secure LDAP
-- ---------------------------------------------------------------------------
-- ldap_google_enabled, ldap_client_cert_path, ldap_client_key_path
-- are stored in the settings table (key/value) via ALLOWED_KEYS in settings.js
