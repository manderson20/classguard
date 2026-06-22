-- Migration 057: Screen Time tracking — pure recording/reporting, no limits.
--
-- The extension's heartbeat (every 30s) already existed but its payload was
-- discarded entirely server-side — only a "last seen" timestamp got
-- updated. This adds the actual data path: chrome.idle-based active/idle/
-- locked state, stitched into continuous intervals server-side rather than
-- storing one row per heartbeat (which would make "total minutes today"
-- queries scan and sum thousands of 30s rows instead of a handful of
-- intervals).
CREATE TABLE IF NOT EXISTS screen_time_intervals (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id         UUID        REFERENCES devices(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  -- NULL while the interval is still open (most recent heartbeat was
  -- 'active' and recent enough not to be considered a gap).
  ended_at          TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ NOT NULL
);

-- The hot path is always "find this student+device's currently-open
-- interval" (ended_at IS NULL) — a partial index keeps that O(1) regardless
-- of how much closed history accumulates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_screen_time_open_interval
  ON screen_time_intervals (student_id, device_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_screen_time_student_day
  ON screen_time_intervals (student_id, started_at DESC);
