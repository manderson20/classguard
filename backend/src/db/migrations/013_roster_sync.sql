-- Migration 013: Google Classroom + OneRoster (Infinite Campus / SIS) roster sync

-- Allow users created from OneRoster or manually (without a Google ID)
ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL;
ALTER TABLE users ALTER COLUMN google_id DROP DEFAULT;

-- OneRoster / SIS identity fields on users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS oneroster_sourced_id  TEXT UNIQUE,  -- OR user sourcedId
  ADD COLUMN IF NOT EXISTS oneroster_username     TEXT,
  ADD COLUMN IF NOT EXISTS student_number         TEXT,         -- district/SIS student ID
  ADD COLUMN IF NOT EXISTS grade_level            TEXT,
  ADD COLUMN IF NOT EXISTS sync_source            TEXT DEFAULT 'manual'; -- google | oneroster | manual

-- OneRoster / SIS identity fields on classes
ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS oneroster_sourced_id  TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS course_code           TEXT,
  ADD COLUMN IF NOT EXISTS period                TEXT,
  ADD COLUMN IF NOT EXISTS school_year           TEXT,
  ADD COLUMN IF NOT EXISTS sync_source           TEXT DEFAULT 'manual'; -- google_classroom | oneroster | manual

-- Track which class_member rows came from which source (so sync can update without
-- wiping manually-added members)
ALTER TABLE class_members
  ADD COLUMN IF NOT EXISTS sync_source TEXT DEFAULT 'manual';

-- OneRoster SIS connections (multiple schools can point to different SIS endpoints)
CREATE TABLE IF NOT EXISTS oneroster_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,                    -- e.g. "Infinite Campus"
  base_url      TEXT NOT NULL,                    -- https://ic.district.k12.us/api/oneroster/v1p1
  client_id     TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  school_year   TEXT,                             -- e.g. "2025-2026" (filter rostering)
  org_filter    TEXT,                             -- optional: filter by org sourcedId
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_sync     TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Google Classroom sync log (separate from Google Admin user sync)
-- Tracks which Classroom courses have been mapped to ClassGuard classes
CREATE TABLE IF NOT EXISTS classroom_course_map (
  classroom_course_id  TEXT PRIMARY KEY,          -- Google Classroom course.id
  class_id             UUID REFERENCES classes(id) ON DELETE SET NULL,
  course_name          TEXT,
  teacher_email        TEXT,
  last_sync            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oneroster_sources_active ON oneroster_sources(is_active);
