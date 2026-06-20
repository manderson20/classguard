-- Migration 031: capture the querying device's source IP on dns_logs.
-- The DNS engine has always sent sourceIp through the Redis log stream
-- (dns-engine/src/logger.js) but the Postgres drain (services/scheduler.js)
-- was dropping it on the floor — added here so unauthenticated devices
-- (Apple TVs, printers, etc. with no associated user) can still be
-- identified by IP against IPAM/phones records.
ALTER TABLE dns_logs ADD COLUMN IF NOT EXISTS source_ip INET;
CREATE INDEX IF NOT EXISTS idx_dns_logs_source_ip ON dns_logs(source_ip) WHERE user_id IS NULL;
