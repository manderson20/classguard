-- Generic reports framework: a registry of report types (hardcoded in
-- services/reports.js, not user-defined) with generated instances stored
-- here so a past report can be re-downloaded without re-running it against
-- since-changed data -- a report is a snapshot, not a live view.
CREATE TABLE generated_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type  VARCHAR(50) NOT NULL,
  params       JSONB,
  format       VARCHAR(10) NOT NULL DEFAULT 'pdf',
  summary      JSONB,
  file_data    BYTEA NOT NULL,
  generated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_generated_reports_type ON generated_reports(report_type, generated_at DESC);
