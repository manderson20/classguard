-- Migration 032: marks DNS records created automatically from active DHCP
-- leases (the ClassGuard equivalent of Windows AD-integrated DNS dynamic
-- update) so the reconciliation job can safely delete only the records it
-- created itself, never anything an admin entered by hand.
ALTER TABLE dns_zone_records ADD COLUMN IF NOT EXISTS auto_registered BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_dns_zone_records_auto ON dns_zone_records(zone_id, auto_registered) WHERE auto_registered = true;
