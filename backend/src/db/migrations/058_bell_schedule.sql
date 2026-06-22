-- Migration 058: Bell schedule + teacher period-utilization summary.
--
-- OneRoster's 'period' field on classes (migration 013) is just a label
-- (e.g. "1", "Period 3", "A") — confirmed against the OneRoster 1.1 spec,
-- there is no clock-time data anywhere in the standard roster model, so no
-- SIS feed (Infinite Campus or otherwise) can supply this; it has to be
-- configured here regardless of feed quality.
CREATE TABLE IF NOT EXISTS bell_schedule_periods (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  period_label  TEXT        NOT NULL UNIQUE, -- must match classes.period values from the roster sync
  name          TEXT,                        -- optional display name, e.g. "1st Period"
  start_time    TIME        NOT NULL,
  end_time      TIME        NOT NULL,
  -- 0=Sunday..6=Saturday, default Mon-Fri. Lets a school exclude a period
  -- that doesn't run every day (e.g. an early-release Wednesday schedule)
  -- without needing a separate schedule-set concept for V1.
  days_of_week  SMALLINT[]  NOT NULL DEFAULT '{1,2,3,4,5}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Per-teacher, per-day, per-period utilization — computed nightly (see
-- scheduler.js) rather than live-queried, since reconciling
-- bell_schedule x classes x class_members x screen_time_intervals for an
-- entire district on every page load would be expensive and this data
-- doesn't need to be real-time.
CREATE TABLE IF NOT EXISTS teacher_period_utilization (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id            UUID        NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  period_label        TEXT        NOT NULL,
  school_date         DATE        NOT NULL,
  enrolled_count       INT        NOT NULL DEFAULT 0,
  active_student_count INT        NOT NULL DEFAULT 0, -- distinct students with ANY device activity overlapping the period
  -- Sum across enrolled students of (active seconds overlapping the period
  -- window), capped per-student at the period's own duration — this is the
  -- "how much of the scheduled time was actually spent on a device" signal,
  -- independent of whether a lesson_session was ever started.
  active_student_seconds BIGINT   NOT NULL DEFAULT 0,
  period_seconds        INT       NOT NULL,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (class_id, period_label, school_date)
);

CREATE INDEX IF NOT EXISTS idx_teacher_period_util_teacher_date
  ON teacher_period_utilization (teacher_id, school_date DESC);
