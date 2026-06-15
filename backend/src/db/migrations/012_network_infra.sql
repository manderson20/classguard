-- Network infrastructure integration
-- Vendor-agnostic: UniFi, Meraki, Aruba, Ruckus, and future vendors

CREATE TABLE IF NOT EXISTS network_controllers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  vendor       TEXT NOT NULL,           -- unifi, meraki, aruba, ruckus, generic
  base_url     TEXT,                    -- Controller URL (NULL for cloud APIs like Meraki)
  site_id      TEXT,                    -- UniFi site, Meraki network ID, etc.
  username     TEXT,                    -- For cookie/basic auth controllers
  password     TEXT,                    -- Stored as plaintext (same model as other creds)
  api_key      TEXT,                    -- For key-based APIs (Meraki, Aruba Central)
  extra_config JSONB DEFAULT '{}',      -- Vendor-specific options
  is_active    BOOLEAN NOT NULL DEFAULT true,
  last_sync    TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nc_vendor ON network_controllers(vendor);

-- Unified client table — one row per client per sync
CREATE TABLE IF NOT EXISTS network_clients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  controller_id  UUID NOT NULL REFERENCES network_controllers(id) ON DELETE CASCADE,
  mac            MACADDR NOT NULL,
  ip_address     INET,
  hostname       TEXT,
  -- Wireless
  ap_name        TEXT,
  ssid           TEXT,
  rssi           SMALLINT,             -- dBm
  channel        SMALLINT,
  radio_type     TEXT,                 -- 2g, 5g, 6g
  -- Wired
  switch_name    TEXT,
  switch_port    TEXT,
  -- Common
  vlan           SMALLINT,
  connection_type TEXT,               -- wireless, wired
  status         TEXT NOT NULL DEFAULT 'online',  -- online, offline
  vendor_oui     TEXT,                -- Vendor from MAC OUI (e.g. "Apple Inc.")
  os_type        TEXT,
  first_seen     TIMESTAMPTZ,
  last_seen      TIMESTAMPTZ,
  raw_data       JSONB,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(controller_id, mac)
);

CREATE INDEX IF NOT EXISTS idx_nc_mac        ON network_clients(mac);
CREATE INDEX IF NOT EXISTS idx_nc_ip         ON network_clients(ip_address);
CREATE INDEX IF NOT EXISTS idx_nc_ctrl       ON network_clients(controller_id);
CREATE INDEX IF NOT EXISTS idx_nc_ap         ON network_clients(ap_name);
CREATE INDEX IF NOT EXISTS idx_nc_status     ON network_clients(status);
CREATE INDEX IF NOT EXISTS idx_nc_last_seen  ON network_clients(last_seen DESC);

-- DNS conditional forwarding zones
-- Queries matching these domains are forwarded to the specified resolver
-- and are NOT subject to blocklist filtering.
-- Primary use case: Active Directory internal zones (e.g. school.local)
CREATE TABLE IF NOT EXISTS dns_forward_zones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain      TEXT NOT NULL UNIQUE,      -- e.g. "school.local", "corp.example.com"
  forward_to  INET NOT NULL,             -- DC or internal DNS server IP
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dfz_domain ON dns_forward_zones(domain);
