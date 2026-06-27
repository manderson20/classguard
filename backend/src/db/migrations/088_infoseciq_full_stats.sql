-- Full learner_stat columns needed for the Technology Exit Ticket PDF.
ALTER TABLE infoseciq_learners
  ADD COLUMN IF NOT EXISTS replied_count               INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS matched_count               INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attachment_count            INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS teachable_count             INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS training_started_count      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS training_completed_count    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plugin_email_report_count   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plugin_simulation_report_count INTEGER DEFAULT 0;

-- How many courses staff must complete each year (district-configurable).
INSERT INTO settings (key, value, updated_at)
VALUES ('infoseciq_required_courses', '10', NOW())
ON CONFLICT (key) DO NOTHING;
