-- Dry-run mode: marks DNS log rows that were resolved during an active
-- dry-run window (i.e. filtering was bypassed, action = 'dry_run_blocked').
-- The partial index keeps it cheap since the vast majority of rows are false.
ALTER TABLE dns_logs ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_dns_logs_dry_run ON dns_logs (dry_run) WHERE dry_run = true;
