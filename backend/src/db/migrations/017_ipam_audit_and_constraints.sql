-- Migration 017: IPAM audit log + unique constraint for controller sync upsert

-- Unique constraint on ip_addresses so ON CONFLICT works in controller → IPAM sync.
-- PostgreSQL doesn't support ADD CONSTRAINT IF NOT EXISTS, so use DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ip_addresses_ip_ipam_subnet_unique'
  ) THEN
    ALTER TABLE ip_addresses
      ADD CONSTRAINT ip_addresses_ip_ipam_subnet_unique
      UNIQUE (ip, ipam_subnet_id);
  END IF;
END$$;

-- Audit log for IPAM mutations (subnets, IPs)
CREATE TABLE IF NOT EXISTS ipam_audit (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name  VARCHAR(50)  NOT NULL,
  record_id   UUID,
  action      VARCHAR(10)  NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  summary     TEXT,
  old_data    JSONB,
  new_data    JSONB,
  changed_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ipam_audit_record ON ipam_audit(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_ipam_audit_time   ON ipam_audit(changed_at DESC);
