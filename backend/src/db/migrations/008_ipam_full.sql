-- Migration 008: Full IPAM expansion — replaces PHPiPAM
-- Adds sections, VRFs, VLANs, locations, IPAM subnets (IPv4/IPv6/nested),
-- BGP prefix tracking, and NAT rule documentation.

-- -------------------------------------------------------------------------
-- Organizational sections (like PHPiPAM "Sections")
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ipam_sections (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  parent_id   UUID         REFERENCES ipam_sections(id) ON DELETE SET NULL,
  color       VARCHAR(7),   -- hex, e.g. #3b82f6
  created_by  UUID         REFERENCES users(id),
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- Physical / logical locations
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  address     TEXT,
  description TEXT,
  parent_id   UUID         REFERENCES locations(id) ON DELETE SET NULL,
  lat         DECIMAL(9,6),
  lng         DECIMAL(9,6),
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- VRFs (Virtual Routing and Forwarding)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vrfs (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL UNIQUE,
  rd          VARCHAR(100),  -- Route Distinguisher, e.g. 65000:100
  description TEXT,
  created_by  UUID         REFERENCES users(id),
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- VLANs
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vlans (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  vlan_id     INT          NOT NULL,   -- 802.1Q tag 1–4094
  name        VARCHAR(255),
  description TEXT,
  section_id  UUID         REFERENCES ipam_sections(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(vlan_id)
);

-- -------------------------------------------------------------------------
-- IPAM subnets — authoritative subnet table (IPv4 + IPv6, nested)
-- dhcp_subnets remains as the Kea DHCP config table; ipam_subnets is the
-- documentation layer.  A DHCP-managed subnet links here via dhcp_subnet_id.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ipam_subnets (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  subnet          CIDR         NOT NULL,
  ip_version      SMALLINT     NOT NULL DEFAULT 4,  -- 4 or 6
  name            VARCHAR(255),
  description     TEXT,
  section_id      UUID         REFERENCES ipam_sections(id) ON DELETE SET NULL,
  vrf_id          UUID         REFERENCES vrfs(id)   ON DELETE SET NULL,
  vlan_id         UUID         REFERENCES vlans(id)  ON DELETE SET NULL,
  location_id     UUID         REFERENCES locations(id) ON DELETE SET NULL,
  parent_id       UUID         REFERENCES ipam_subnets(id) ON DELETE SET NULL,
  gateway         INET,
  dns_servers     INET[]       DEFAULT '{}',
  dhcp_subnet_id  UUID         REFERENCES dhcp_subnets(id) ON DELETE SET NULL,
  allow_requests  BOOLEAN      DEFAULT false,
  is_full         BOOLEAN      DEFAULT false,
  tags            TEXT[]       DEFAULT '{}',
  notes           TEXT,
  created_by      UUID         REFERENCES users(id),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(subnet, COALESCE(vrf_id, '00000000-0000-0000-0000-000000000000'::UUID))
);

CREATE INDEX IF NOT EXISTS idx_ipam_subnets_section  ON ipam_subnets(section_id);
CREATE INDEX IF NOT EXISTS idx_ipam_subnets_vrf      ON ipam_subnets(vrf_id);
CREATE INDEX IF NOT EXISTS idx_ipam_subnets_parent   ON ipam_subnets(parent_id);
CREATE INDEX IF NOT EXISTS idx_ipam_subnets_version  ON ipam_subnets(ip_version);

-- Add ipam_subnet_id and status to ip_addresses (was only linked to dhcp_subnets)
ALTER TABLE ip_addresses
  ADD COLUMN IF NOT EXISTS ipam_subnet_id UUID REFERENCES ipam_subnets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ip_version     SMALLINT DEFAULT 4,
  ADD COLUMN IF NOT EXISTS status         VARCHAR(20) DEFAULT 'used',
  -- status: used | free | reserved | offline | dhcp
  ADD COLUMN IF NOT EXISTS ping_status    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS last_seen      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ip_addresses_ipam_subnet ON ip_addresses(ipam_subnet_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_status      ON ip_addresses(status);

-- -------------------------------------------------------------------------
-- BGP prefix tracking
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bgp_prefixes (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  prefix      CIDR         NOT NULL,
  ip_version  SMALLINT     NOT NULL DEFAULT 4,
  description TEXT,
  asn         BIGINT,           -- origin/local ASN
  peer_asn    BIGINT,
  peer_ip     INET,
  next_hop    INET,
  origin      VARCHAR(20),      -- IGP | EGP | INCOMPLETE
  status      VARCHAR(20)  DEFAULT 'active',  -- active | inactive | withdrawn
  communities TEXT[]       DEFAULT '{}',
  vrf_id      UUID         REFERENCES vrfs(id) ON DELETE SET NULL,
  notes       TEXT,
  created_by  UUID         REFERENCES users(id),
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bgp_prefix ON bgp_prefixes USING GIST(prefix inet_ops);
CREATE INDEX IF NOT EXISTS idx_bgp_asn    ON bgp_prefixes(asn);

-- -------------------------------------------------------------------------
-- NAT rule documentation
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nat_rules (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  nat_type        VARCHAR(20)  NOT NULL,
  -- nat_type: source | destination | masquerade | static | pat
  src_prefix      CIDR,
  dst_prefix      CIDR,
  translated_src  CIDR,
  translated_dst  CIDR,
  src_port        VARCHAR(50),
  dst_port        VARCHAR(50),
  translated_port VARCHAR(50),
  protocol        VARCHAR(10)  DEFAULT 'any',  -- tcp | udp | icmp | any
  interface       VARCHAR(100),
  description     TEXT,
  is_active       BOOLEAN      DEFAULT true,
  notes           TEXT,
  created_by      UUID         REFERENCES users(id),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);
