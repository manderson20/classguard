-- Migration 020: Local DNS zones + authoritative records management
-- Note: dns_records already exists for IPAM (linked to ip_addresses).
--       dns_forward_zones already exists for conditional forwarding.
--       New tables use dns_zones (authoritative zones) + dns_zone_records.

CREATE TABLE IF NOT EXISTS dns_zones (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(253) UNIQUE NOT NULL,  -- 'school.local', '1.168.192.in-addr.arpa'
  type        VARCHAR(10)  NOT NULL DEFAULT 'forward'
              CHECK (type IN ('forward','reverse')),
  description TEXT,
  is_active   BOOLEAN      DEFAULT true,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dns_zone_records (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id     UUID         NOT NULL REFERENCES dns_zones(id) ON DELETE CASCADE,
  name        VARCHAR(253) NOT NULL,  -- '@' for zone apex, relative name, or absolute FQDN
  type        VARCHAR(10)  NOT NULL
              CHECK (type IN ('A','AAAA','CNAME','MX','TXT','PTR','SRV','NS')),
  value       TEXT         NOT NULL,
  ttl         INT          NOT NULL DEFAULT 300,
  priority    SMALLINT,   -- MX / SRV
  weight      SMALLINT,   -- SRV
  port        SMALLINT,   -- SRV
  is_active   BOOLEAN      DEFAULT true,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (zone_id, name, type, value)
);

CREATE INDEX IF NOT EXISTS idx_dns_zone_records_zone      ON dns_zone_records(zone_id);
CREATE INDEX IF NOT EXISTS idx_dns_zone_records_name_type ON dns_zone_records(name, type);
