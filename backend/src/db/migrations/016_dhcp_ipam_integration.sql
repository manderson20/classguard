-- Migration 016: DHCP ↔ IPAM integration
-- Allows IPAM subnets to define a DHCP pool, auto-creating the dhcp_subnets
-- record. Adds dhcp_options for global and per-scope option management.

-- Add DHCP pool fields to ipam_subnets
ALTER TABLE ipam_subnets
  ADD COLUMN IF NOT EXISTS dhcp_enabled    BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS dhcp_pool_start INET,
  ADD COLUMN IF NOT EXISTS dhcp_pool_end   INET;

-- DHCP Options — global options (scope='global') and per-scope overrides (scope='subnet')
CREATE TABLE IF NOT EXISTS dhcp_options (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          VARCHAR(10)  NOT NULL DEFAULT 'global',
  dhcp_subnet_id UUID         REFERENCES dhcp_subnets(id) ON DELETE CASCADE,
  option_code    SMALLINT,
  option_name    VARCHAR(100) NOT NULL,   -- Kea canonical name (e.g. 'domain-name-servers')
  option_label   VARCHAR(100),            -- human-readable (e.g. 'DNS Servers')
  option_data    TEXT         NOT NULL,   -- value, comma-separated for multi-value
  is_active      BOOLEAN      DEFAULT true,
  created_by     UUID         REFERENCES users(id),
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT dhcp_options_scope_check CHECK (scope IN ('global', 'subnet')),
  CONSTRAINT dhcp_options_subnet_req CHECK (
    (scope = 'global' AND dhcp_subnet_id IS NULL) OR
    (scope = 'subnet' AND dhcp_subnet_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_dhcp_options_scope  ON dhcp_options(scope);
CREATE INDEX IF NOT EXISTS idx_dhcp_options_subnet ON dhcp_options(dhcp_subnet_id);
