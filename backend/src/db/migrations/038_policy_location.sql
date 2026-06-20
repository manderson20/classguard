-- Migration 038: On-Campus vs Off-Campus policy assignments.
-- A student/group/OU can now have up to two assignments — one tagged
-- on_campus, one tagged off_campus — in addition to a location-agnostic
-- 'any' assignment (the existing default behavior). Location is determined
-- at resolution time from the student's current source IP against
-- documented school subnets in IPAM.
ALTER TABLE policy_assignments
  ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT 'any'
    CHECK (location IN ('any','on_campus','off_campus'));

-- Replace the old per-policy uniqueness with per-target-per-location
-- uniqueness: a target should map to at most one policy per location,
-- regardless of which policy that happens to be (previously you could
-- already assign two different policies to the same OU with no conflict,
-- since policy_id was part of the unique key — resolvePolicy had no way to
-- pick between them deterministically).
DROP INDEX IF EXISTS policy_assignments_student_group_unique;
CREATE UNIQUE INDEX IF NOT EXISTS policy_assignments_student_group_unique
  ON policy_assignments (target_type, target_id, location);

DROP INDEX IF EXISTS policy_assignments_ou_unique;
CREATE UNIQUE INDEX IF NOT EXISTS policy_assignments_ou_unique
  ON policy_assignments (target_type, target_ou, location);
