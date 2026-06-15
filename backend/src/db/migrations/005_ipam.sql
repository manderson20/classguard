-- IPAM: IP Address Management
-- Subnets are already documented in dhcp_subnets.  IPAM adds a documentation
-- layer for every individual address in a subnet — static servers, printers,
-- APs, cameras — cross-referencing DHCP reservations and live Kea leases.

CREATE TABLE IF NOT EXISTS ip_addresses (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  subnet_id    UUID         REFERENCES dhcp_subnets(id) ON DELETE SET NULL,
  ip           INET         NOT NULL UNIQUE,
  hostname     VARCHAR(255),
  description  TEXT,
  device_type  VARCHAR(100),           -- server | printer | ap | switch | camera | voip | student | staff | other
  mac_address  MACADDR,
  owner        VARCHAR(255),           -- person, department, or system name
  tags         TEXT[]       DEFAULT '{}',
  notes        TEXT,
  is_gateway   BOOLEAN      DEFAULT false,
  is_static    BOOLEAN      DEFAULT true,  -- false = just documenting a DHCP-assigned address
  created_by   UUID         REFERENCES users(id),
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ipam_ip_subnet  ON ip_addresses (subnet_id);
CREATE INDEX IF NOT EXISTS ipam_ip_mac     ON ip_addresses (mac_address);
CREATE INDEX IF NOT EXISTS ipam_ip_type    ON ip_addresses (device_type);

-- DNS record documentation tied to IPAM entries
CREATE TABLE IF NOT EXISTS dns_records (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_id        UUID         REFERENCES ip_addresses(id) ON DELETE CASCADE,
  record_type  VARCHAR(10)  NOT NULL,   -- A | AAAA | PTR | CNAME | MX | TXT
  name         VARCHAR(255) NOT NULL,   -- FQDN or relative name
  value        VARCHAR(500) NOT NULL,   -- IP, hostname, or text content
  ttl          INT          DEFAULT 3600,
  zone         VARCHAR(255),            -- DNS zone this belongs to
  is_managed   BOOLEAN      DEFAULT false, -- true = ClassGuard manages this in the DNS server
  notes        TEXT,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dns_records_ip    ON dns_records (ip_id);
CREATE INDEX IF NOT EXISTS dns_records_name  ON dns_records (name);
CREATE INDEX IF NOT EXISTS dns_records_zone  ON dns_records (zone);

-- Scan log: record when we last scanned/discovered each IP
CREATE TABLE IF NOT EXISTS ipam_scan_log (
  id           BIGSERIAL    PRIMARY KEY,
  subnet_id    UUID         REFERENCES dhcp_subnets(id) ON DELETE CASCADE,
  scanned_at   TIMESTAMPTZ  DEFAULT NOW(),
  discovered   INT          DEFAULT 0,   -- new IPs seen
  conflicts    INT          DEFAULT 0,   -- IPs claimed by both static and DHCP pool
  duration_ms  INT
);

-- Extend dhcp_subnets with IPAM fields (idempotent)
ALTER TABLE dhcp_subnets
  ADD COLUMN IF NOT EXISTS vlan_id       INT,
  ADD COLUMN IF NOT EXISTS location      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS ipam_enabled  BOOLEAN DEFAULT true;
