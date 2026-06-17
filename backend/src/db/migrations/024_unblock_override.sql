-- Migration 024: unblock requests + override codes

-- Unblock access requests submitted from the block page
CREATE TABLE IF NOT EXISTS unblock_requests (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  domain           VARCHAR(255) NOT NULL,
  student_id       UUID         REFERENCES users(id)  ON DELETE SET NULL,
  requester_email  VARCHAR(255),
  requester_name   VARCHAR(255),
  reason           TEXT,
  status           VARCHAR(20)  NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'denied')),
  source_ip        INET,
  reviewed_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMPTZ,
  review_note      TEXT,
  requested_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- One pending request per authenticated student per domain
CREATE UNIQUE INDEX IF NOT EXISTS unblock_requests_student_pending
  ON unblock_requests (student_id, domain)
  WHERE status = 'pending' AND student_id IS NOT NULL;

-- One pending request per email per domain (for non-extension / DNS block page submissions)
CREATE UNIQUE INDEX IF NOT EXISTS unblock_requests_email_pending
  ON unblock_requests (requester_email, domain)
  WHERE status = 'pending' AND requester_email IS NOT NULL AND student_id IS NULL;

CREATE INDEX IF NOT EXISTS unblock_requests_status_idx  ON unblock_requests (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS unblock_requests_domain_idx  ON unblock_requests (domain);

-- Admin-generated temporary override codes
-- Bypasses policy blocks for a specific domain + time window.
-- CIPA-floor categories (adult, malware, etc.) are excluded at generation time.
CREATE TABLE IF NOT EXISTS override_codes (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code           VARCHAR(10)  NOT NULL UNIQUE,
  domain         VARCHAR(255) NOT NULL,
  generated_by   UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generated_at   TIMESTAMPTZ  DEFAULT NOW(),
  expires_at     TIMESTAMPTZ  NOT NULL,
  used_at        TIMESTAMPTZ,
  used_by_ip     INET,
  used_by_student UUID        REFERENCES users(id) ON DELETE SET NULL,
  notes          TEXT,
  -- Optional: restrict code to a specific student; NULL = any student
  target_student_id UUID      REFERENCES users(id) ON DELETE SET NULL,
  unblock_request_id UUID     REFERENCES unblock_requests(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS override_codes_code_idx
  ON override_codes (code)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS override_codes_domain_idx ON override_codes (domain);
