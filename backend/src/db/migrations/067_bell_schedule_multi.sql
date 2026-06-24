-- Multiple bell schedules, matched to a student by EITHER their Google OU
-- (longest-prefix match, same pattern as policy_assignments) OR their
-- OneRoster-synced grade_level (exact match) -- never both at once, picked
-- district-wide via settings.bell_schedule_match_mode, so there's exactly
-- one unambiguous way a student resolves to a schedule. Building/school
-- level matching isn't supported yet -- OneRoster orgs/schools aren't
-- synced into ClassGuard at all today, that's a bigger gap than a new
-- matching rule would close on its own.
CREATE TABLE bell_schedules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  is_default  BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Exactly one default schedule -- the fallback for any student that no
-- assignment rule matches.
CREATE UNIQUE INDEX bell_schedules_one_default ON bell_schedules(is_default) WHERE is_default = true;

INSERT INTO bell_schedules (name, description, is_default)
VALUES ('Default Schedule', 'Applies to any student no assignment rule matches.', true);

-- Periods now belong to a specific schedule instead of being one global
-- set -- the same period_label ("3", "Period 3") can mean a different
-- time in two different schedules.
ALTER TABLE bell_schedule_periods ADD COLUMN schedule_id UUID REFERENCES bell_schedules(id) ON DELETE CASCADE;
UPDATE bell_schedule_periods SET schedule_id = (SELECT id FROM bell_schedules WHERE is_default = true);
ALTER TABLE bell_schedule_periods ALTER COLUMN schedule_id SET NOT NULL;
ALTER TABLE bell_schedule_periods DROP CONSTRAINT bell_schedule_periods_period_label_key;
ALTER TABLE bell_schedule_periods ADD CONSTRAINT bell_schedule_periods_schedule_label_uniq UNIQUE (schedule_id, period_label);

-- Which schedule applies to which students. target_ou uses the exact
-- longest-prefix-match pattern policyResolver.js already uses for OU-based
-- policy targeting; target_grade_level is an exact match against
-- users.grade_level (synced from OneRoster, currently unused elsewhere).
CREATE TABLE bell_schedule_assignments (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        UUID        NOT NULL REFERENCES bell_schedules(id) ON DELETE CASCADE,
  target_type        VARCHAR(20) NOT NULL CHECK (target_type IN ('ou', 'grade_level')),
  target_ou          VARCHAR(500),
  target_grade_level TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (target_type = 'ou'         AND target_ou IS NOT NULL AND target_grade_level IS NULL) OR
    (target_type = 'grade_level' AND target_grade_level IS NOT NULL AND target_ou IS NULL)
  )
);
CREATE UNIQUE INDEX bell_schedule_assignments_ou_uniq
  ON bell_schedule_assignments(target_ou) WHERE target_type = 'ou';
CREATE UNIQUE INDEX bell_schedule_assignments_grade_uniq
  ON bell_schedule_assignments(target_grade_level) WHERE target_type = 'grade_level';
