-- Cached learner/compliance data from Infosec IQ
CREATE TABLE IF NOT EXISTS infoseciq_learners (
  id                      TEXT PRIMARY KEY,  -- Infosec IQ learner/user ID
  email                   TEXT,
  first_name              TEXT,
  last_name               TEXT,
  department              TEXT,
  risk_score              NUMERIC,
  training_completion_pct NUMERIC,
  courses_assigned        INTEGER,
  courses_completed       INTEGER,
  phishing_susceptibility NUMERIC,  -- % of phish simulations clicked
  last_activity_at        TIMESTAMPTZ,
  raw_data                JSONB,
  last_synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infoseciq_learners_email ON infoseciq_learners(email);

-- Phishing campaign / simulation headers
CREATE TABLE IF NOT EXISTS infoseciq_campaigns (
  id               TEXT PRIMARY KEY,
  name             TEXT,
  status           TEXT,
  start_date       TIMESTAMPTZ,
  end_date         TIMESTAMPTZ,
  recipients_total INTEGER,
  emails_sent      INTEGER,
  opens            INTEGER,
  clicks           INTEGER,
  reports          INTEGER,
  click_rate       NUMERIC,
  report_rate      NUMERIC,
  raw_data         JSONB,
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-recipient phishing results
CREATE TABLE IF NOT EXISTS infoseciq_campaign_results (
  id           SERIAL PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES infoseciq_campaigns(id) ON DELETE CASCADE,
  learner_id   TEXT,
  email        TEXT,
  first_name   TEXT,
  last_name    TEXT,
  department   TEXT,
  sent_at      TIMESTAMPTZ,
  opened_at    TIMESTAMPTZ,
  clicked_at   TIMESTAMPTZ,
  reported_at  TIMESTAMPTZ,
  raw_data     JSONB,
  UNIQUE (campaign_id, email)
);

CREATE INDEX IF NOT EXISTS idx_infoseciq_results_campaign ON infoseciq_campaign_results(campaign_id);
CREATE INDEX IF NOT EXISTS idx_infoseciq_results_email    ON infoseciq_campaign_results(email);
