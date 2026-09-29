-- Schools (ISS spec Phase 0, docs/features/in-school-suspension.md §3).
--
-- A district's schools, and which school(s) each user and class belongs to,
-- so later features (ISS roles, SCORM sharing, reports) can be scoped by
-- school. Filled from three sources:
--   * OneRoster: orgs of type 'school' (oneroster_sourced_id), each user's
--     orgs, and each class's school;
--   * Google OU rules: a school lists the OU prefixes whose users belong to
--     it (e.g. '/Students/High School' and '/Employees/High School');
--   * manual: an admin adds a school to a user (e.g. staff who serve
--     several buildings).
-- services/schools.js recomputes the 'ou' and 'oneroster' rows; 'manual'
-- rows are only ever changed by an admin.

CREATE TABLE IF NOT EXISTS schools (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT        NOT NULL,
  oneroster_sourced_id TEXT        UNIQUE,
  ou_prefixes          TEXT[]      NOT NULL DEFAULT '{}',
  is_active            BOOLEAN     NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS schools_name_active_unique
  ON schools (lower(name)) WHERE is_active;

CREATE TABLE IF NOT EXISTS user_schools (
  user_id    UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  school_id  UUID        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  source     TEXT        NOT NULL CHECK (source IN ('oneroster', 'ou', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, school_id, source)
);

CREATE INDEX IF NOT EXISTS user_schools_school_idx ON user_schools (school_id);

ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id) ON DELETE SET NULL;

-- 'oneroster' = set by OneRoster sync; 'manual' = set by an admin; 'derived'
-- (or NULL) = worked out from the teacher's / students' schools and
-- recomputed on every schools recompute.
ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS school_source TEXT
  CHECK (school_source IN ('oneroster', 'manual', 'derived'));
