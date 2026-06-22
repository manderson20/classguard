-- Migration 059: Lockdown Browser for tests.
--
-- A teacher-initiated, single-URL browser lock (e.g. a Google Form), distinct
-- from lesson_sessions' multi-domain whitelist: lockdown is meant to pin a
-- student to ONE exact test page, optionally time-limited, and is visible
-- and force-endable district-wide (an admin "get them out" kill switch),
-- which lesson_sessions never needed.
--
-- This is a SOFT lock — a Chrome extension cannot block OS-level app
-- switching the way a native kiosk app can — so escape attempts (new tab,
-- new window, tab switch, losing window focus) are corrected and logged
-- rather than physically prevented.
CREATE TABLE IF NOT EXISTS lockdown_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  teacher_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id     UUID        REFERENCES classes(id) ON DELETE SET NULL,
  target_url   TEXT        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at      TIMESTAMPTZ,                    -- NULL = no time limit, manual end only
  ended_at     TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'active', -- active | ended | expired
  ended_by     UUID        REFERENCES users(id)        -- NULL while active; teacher or admin who ended it
);

-- Hot path for policy resolution: "does this student have an active lockdown
-- right now" — same partial-unique-index pattern as screen_time_intervals,
-- with the same caveat that it's a soft guard, not a strict invariant (the
-- app layer always closes any prior active session before starting a new
-- one for the same student, so this should never actually collide).
CREATE UNIQUE INDEX IF NOT EXISTS idx_lockdown_active_student
  ON lockdown_sessions (student_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_lockdown_teacher ON lockdown_sessions (teacher_id, started_at DESC);

CREATE TABLE IF NOT EXISTS lockdown_events (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lockdown_session_id UUID        NOT NULL REFERENCES lockdown_sessions(id) ON DELETE CASCADE,
  event_type          TEXT        NOT NULL, -- new_tab | new_window | tab_switch | tab_closed | focus_loss
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail              TEXT
);

CREATE INDEX IF NOT EXISTS idx_lockdown_events_session ON lockdown_events (lockdown_session_id, occurred_at DESC);
