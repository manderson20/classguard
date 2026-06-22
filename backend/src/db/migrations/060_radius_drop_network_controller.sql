-- Migration 060: RADIUS client devices should never come from the network
-- controller (APs/switches) — that source is for provisioning the
-- APs/switches themselves as RADIUS NAS clients, not for the end-user
-- device allowlist. radiusSync.js no longer writes network_controller rows
-- at all; this cleans up what the old sync already wrote.
--
-- Safety: only removes rows that are still 'pending' (i.e. never reviewed
-- by an admin) AND have no other surviving active source. Anything an
-- admin explicitly approved or blocked is left untouched regardless of
-- source, and any device also tracked by a real MDM source (Mosyle/
-- Snipe-IT/Google Admin) keeps its radius_devices row — only the stale
-- network_controller source-tracking entry is removed for those.

DELETE FROM radius_device_sources WHERE source = 'network_controller';

-- Devices that have a surviving real source after the delete above: fix up
-- the device's source label, which is frozen at whatever source first
-- created the row and would otherwise still read 'network_controller'
-- even though it's now properly tracked by a real MDM sync.
UPDATE radius_devices rd
SET source = sub.source
FROM (
  SELECT DISTINCT ON (device_id) device_id, source
  FROM radius_device_sources
  WHERE is_active = true
  ORDER BY device_id, source
) sub
WHERE rd.id = sub.device_id AND rd.source = 'network_controller';

-- Devices with no surviving source at all and never reviewed — pure
-- auto-discovered noise from the retired sync, safe to remove outright.
DELETE FROM radius_devices rd
WHERE rd.source = 'network_controller'
  AND rd.status = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM radius_device_sources rds WHERE rds.device_id = rd.id AND rds.is_active = true
  );
