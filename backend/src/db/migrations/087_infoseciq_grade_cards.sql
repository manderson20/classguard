-- Richer per-learner grade card fields sourced from /learners/{id} API.
ALTER TABLE infoseciq_learners
  ADD COLUMN IF NOT EXISTS letter_grade          TEXT,
  ADD COLUMN IF NOT EXISTS grade_score           NUMERIC,
  ADD COLUMN IF NOT EXISTS phished_count         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS data_entry_count      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS training_time_minutes INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS modules_enrolled      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS modules_completed     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS assessments_passed    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS assessments_failed    INTEGER DEFAULT 0;

-- Campaign type (awareness / phish) from the API response.
ALTER TABLE infoseciq_campaigns
  ADD COLUMN IF NOT EXISTS campaign_type TEXT;

-- Fix campaign_results:
--   Old unique constraint was (campaign_id, email) — email is always NULL from
--   the run-learner endpoint, so it never matched and results were never stored.
--   Replace with (campaign_id, learner_id) and add completion status fields.
ALTER TABLE infoseciq_campaign_results
  DROP CONSTRAINT IF EXISTS infoseciq_campaign_results_campaign_id_email_key,
  ADD COLUMN IF NOT EXISTS completion_status TEXT,
  ADD COLUMN IF NOT EXISTS completed_on      TIMESTAMP WITH TIME ZONE;

-- Partial unique index: one row per learner per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS idx_infoseciq_results_campaign_learner
  ON infoseciq_campaign_results (campaign_id, learner_id)
  WHERE learner_id IS NOT NULL;

-- Clear stale rows with no learner_id (all previous null-email inserts).
DELETE FROM infoseciq_campaign_results WHERE learner_id IS NULL;
