-- Migration 022: Subnet policy assignments + YouTube category filtering

-- Add subnet CIDR targeting (for DNS-level filtering: iPads, BYOD, guest)
ALTER TABLE policy_assignments
  ADD COLUMN IF NOT EXISTS target_subnet CIDR;

-- Partial unique index for subnet assignments
CREATE UNIQUE INDEX IF NOT EXISTS policy_assignments_subnet_idx
  ON policy_assignments (policy_id, target_type, target_subnet)
  WHERE target_subnet IS NOT NULL;

-- Add youtube_categories for per-policy YouTube category blocking
-- Stored as { mode: 'blocklist'|'allowlist', blocked: [...], allowed: [...] }
ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS youtube_categories JSONB DEFAULT '{}';
