-- Penalty Box "Allow site…" and bell-schedule lesson end times.
--
-- penalty_box.allowed_domains: sites a restricted student may still reach.
-- Filled when an admin approves a teacher's "Allow site…" request for that
-- restriction (routes/unblockRequests.js); read by resolvePolicy() for the
-- penalty_box mode, so both DNS and the extension allow them. Scoped to the
-- one restriction: a later restriction starts with an empty list again.
--
-- unblock_requests.penalty_box_id: links a request made through "Allow
-- site…" to the restriction it was made for, so approving it knows where to
-- grant the site. NULL for ordinary unblock requests.
--
-- lesson_sessions.ends_at: when the scheduler should end the session by
-- itself. Set for sessions auto-started from the bell schedule (the period's
-- end); NULL for sessions a teacher starts, which still run until End Class.

ALTER TABLE penalty_box
  ADD COLUMN IF NOT EXISTS allowed_domains JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE unblock_requests
  ADD COLUMN IF NOT EXISTS penalty_box_id UUID REFERENCES penalty_box(id) ON DELETE SET NULL;

ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
