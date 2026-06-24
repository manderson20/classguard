-- Dependency vulnerability scanning (npm audit + CISA KEV cross-reference).
-- Keeps a short history of scan runs, not just the latest -- mainly so
-- "is this getting better or worse" is answerable without re-running.
CREATE TABLE security_scans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status       VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  error        TEXT,
  summary      JSONB
);

CREATE TABLE security_scan_findings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id                UUID NOT NULL REFERENCES security_scans(id) ON DELETE CASCADE,
  package_name           VARCHAR(255) NOT NULL,
  severity               VARCHAR(20) NOT NULL,
  title                  TEXT,
  ghsa_id                VARCHAR(30),
  cve_id                 VARCHAR(30),
  url                    TEXT,
  is_kev                 BOOLEAN NOT NULL DEFAULT false,
  kev_due_date           DATE,
  fix_available_version  VARCHAR(100),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_security_scan_findings_scan ON security_scan_findings(scan_id);
CREATE INDEX idx_security_scans_started ON security_scans(started_at DESC);
