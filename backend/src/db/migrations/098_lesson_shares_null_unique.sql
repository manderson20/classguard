-- School-wide shares use shared_with = NULL, but the original
-- UNIQUE(lesson_id, shared_with) treats NULLs as distinct — so ON CONFLICT
-- never fired for them and every "Share with all staff" toggle stacked
-- another duplicate row. Dedupe, then recreate the constraint with
-- Postgres 15's NULLS NOT DISTINCT so the existing ON CONFLICT
-- (lesson_id, shared_with) arbiters correctly for both cases.
DELETE FROM classpulse_lesson_shares a
  USING classpulse_lesson_shares b
  WHERE a.lesson_id = b.lesson_id
    AND a.shared_with IS NULL
    AND b.shared_with IS NULL
    AND a.ctid > b.ctid;

ALTER TABLE classpulse_lesson_shares
  DROP CONSTRAINT classpulse_lesson_shares_lesson_id_shared_with_key;

ALTER TABLE classpulse_lesson_shares
  ADD CONSTRAINT classpulse_lesson_shares_lesson_id_shared_with_key
  UNIQUE NULLS NOT DISTINCT (lesson_id, shared_with);
