-- Teacher Live View Phase 3: session-scoped history. lesson_sessions.id was
-- already looked up during policy resolution (policyResolver.js, mode
-- 'lesson') but never attached to dns_logs/browser_history rows, so a
-- teacher had no way to scope a student's history to just the active
-- lesson session. Threaded through the same Redis-stream pipeline device_id
-- already uses.
--
-- No FK constraint (unlike most denormalized columns in this codebase) —
-- both tables are TimescaleDB hypertables with compression already enabled,
-- and Timescale rejects ALTER TABLE ADD COLUMN with any constraint on a
-- compressed hypertable ("cannot add column with constraints to a
-- hypertable that has columnstore enabled"). lesson_sessions rows are never
-- deleted in normal operation, so this is a low-risk gap.
ALTER TABLE dns_logs        ADD COLUMN IF NOT EXISTS lesson_session_id UUID;
ALTER TABLE browser_history ADD COLUMN IF NOT EXISTS lesson_session_id UUID;

CREATE INDEX IF NOT EXISTS idx_dns_logs_lesson_session        ON dns_logs(lesson_session_id, queried_at DESC);
CREATE INDEX IF NOT EXISTS idx_browser_history_lesson_session ON browser_history(lesson_session_id, visited_at DESC);
