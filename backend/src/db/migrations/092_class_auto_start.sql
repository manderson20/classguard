-- Migration 092: per-class opt-in for bell-schedule auto-start lessons
--
-- Off by default, deliberately opt-in per class rather than a district-wide
-- or OU-level setting -- only the teacher actually knows whether their real
-- room usage matches the bell schedule closely enough for this to be useful
-- (a co-taught class, a lab period that runs long, etc. might not).

ALTER TABLE classes ADD COLUMN IF NOT EXISTS auto_start_lessons BOOLEAN NOT NULL DEFAULT false;
