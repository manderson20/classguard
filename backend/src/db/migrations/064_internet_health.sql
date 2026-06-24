-- Upstream internet/DNS connectivity history. Distinct from systemHealth.js's
-- /api/v1/system/health (self-hosted services ClassGuard controls the
-- version of) and integrations.js (vendor APIs) — this is the third
-- category: is the actual internet uplink and DNS resolution working at all.
-- Plain table, not a hypertable — a check every couple minutes is a few
-- hundred KB/year, no need for TimescaleDB's compression/chunking here.
CREATE TABLE internet_health_checks (
  id          BIGSERIAL PRIMARY KEY,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dns_ok          BOOLEAN NOT NULL,
  dns_server      INET,
  dns_latency_ms  INTEGER,
  dns_error       TEXT,
  ip_ok           BOOLEAN NOT NULL,
  ip_target       INET,
  ip_latency_ms   INTEGER,
  ip_error        TEXT
);

CREATE INDEX idx_internet_health_checks_checked_at ON internet_health_checks (checked_at DESC);
