-- Migration 026: generalize VRRP health-check tracking on the shared VIP config.
-- radius_ha_config already holds the cluster's VIP — it's used by the ClassGuard
-- web UI for every node, and additionally by FreeRADIUS on nodes that run it.
-- track_freeradius existed but was ignored by the generator (always checked
-- FreeRADIUS, which doesn't exist on web-only nodes). Add an explicit toggle
-- for tracking the ClassGuard API itself, on by default.

ALTER TABLE radius_ha_config
  ADD COLUMN IF NOT EXISTS track_classguard_api BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE radius_ha_config
  ALTER COLUMN track_freeradius SET DEFAULT false;

-- Correct the existing seeded row: it defaulted track_freeradius to true even
-- though the previous generator ignored the flag. Turn it off unless this
-- district actually has NAS clients configured (i.e. is really running RADIUS).
UPDATE radius_ha_config SET track_freeradius = false
WHERE NOT EXISTS (SELECT 1 FROM radius_nas WHERE is_active = true);
