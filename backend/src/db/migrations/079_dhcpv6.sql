-- DHCPv6 scopes
CREATE TABLE IF NOT EXISTS dhcp_subnets_v6 (
  id                         SERIAL PRIMARY KEY,
  kea_subnet_id              INTEGER NOT NULL UNIQUE,
  subnet                     CIDR    NOT NULL UNIQUE,
  label                      TEXT,
  pool_start                 INET    NOT NULL,
  pool_end                   INET    NOT NULL,
  dns_servers                INET[],
  domain_name                TEXT,
  preferred_lifetime_seconds INTEGER NOT NULL DEFAULT 43200,
  valid_lifetime_seconds     INTEGER NOT NULL DEFAULT 86400,
  notes                      TEXT,
  is_active                  BOOLEAN NOT NULL DEFAULT true,
  created_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DHCPv6 reservations — identified by DUID, not MAC
-- DUID format example: 00:03:00:01:aa:bb:cc:dd:ee:ff (DUID-LL)
CREATE TABLE IF NOT EXISTS dhcp_reservations_v6 (
  id          SERIAL PRIMARY KEY,
  subnet_id   INTEGER NOT NULL REFERENCES dhcp_subnets_v6(id) ON DELETE CASCADE,
  duid        TEXT    NOT NULL UNIQUE,
  ip_address  INET    NOT NULL,
  hostname    TEXT,
  device_id   UUID REFERENCES devices(id) ON DELETE SET NULL,
  notes       TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dhcp_res_v6_subnet ON dhcp_reservations_v6(subnet_id);
CREATE INDEX IF NOT EXISTS idx_dhcp_res_v6_ip     ON dhcp_reservations_v6(ip_address);

-- DHCPv6 custom options (global or per-subnet, e.g. NTP, domain search)
CREATE TABLE IF NOT EXISTS dhcp_options_v6 (
  id             SERIAL PRIMARY KEY,
  scope          TEXT    NOT NULL CHECK (scope IN ('global','subnet')) DEFAULT 'global',
  dhcp_subnet_id INTEGER REFERENCES dhcp_subnets_v6(id) ON DELETE CASCADE,
  option_code    INTEGER,
  option_name    TEXT    NOT NULL,
  option_label   TEXT,
  option_data    TEXT    NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dhcp_options_v6_scope_name
  ON dhcp_options_v6 (scope, COALESCE(dhcp_subnet_id, 0), option_name);
