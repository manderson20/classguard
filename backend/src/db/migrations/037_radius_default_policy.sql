-- Migration 037: allow a radius_user_policies row to have no user_id AND no
-- group_id, meaning "applies to anyone authenticating on the matching SSID"
-- (a default/catch-all policy) — for BYOD-style SSIDs where any Google
-- Workspace user should be able to authenticate without being added to a
-- group first.
ALTER TABLE radius_user_policies DROP CONSTRAINT IF EXISTS chk_user_or_group;
