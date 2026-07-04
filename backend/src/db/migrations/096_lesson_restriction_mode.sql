-- Class sessions can now run in two restriction modes:
--   'focus'   — students may only reach the session's allowed_domains
--               (the original, and previously only, behavior)
--   'monitor' — students keep their normal district/policy filtering; the
--               session exists for visibility (live view, history tagging,
--               ClassPulse) without changing what students can reach.
-- Default stays 'focus' so nothing changes for existing rows or callers.
ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS restriction_mode TEXT NOT NULL DEFAULT 'focus'
  CHECK (restriction_mode IN ('focus', 'monitor'));
