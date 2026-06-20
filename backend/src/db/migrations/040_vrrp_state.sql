-- Tracks which node currently holds the VRRP virtual IP, reported live by
-- keepalived's notify.sh on each MASTER/BACKUP/FAULT transition (see
-- POST /api/v1/ha/vrrp-notify). Deliberately separate from ha_role, which
-- describes the Postgres replication role (primary/standby/replica) and
-- does NOT change automatically on VRRP failover — promoting a standby's
-- database is still a manual step.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS vrrp_state VARCHAR(20);
