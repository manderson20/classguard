-- Tracks devices that are online (per the UniFi network_clients
-- integration) and assigned to a student, but generating zero DNS queries
-- through ClassGuard's own resolver -- the signal a student has switched
-- DNS servers, is tunneling, or otherwise routed around the filter
-- entirely. 'pending' requires a second consecutive detection (~15-30 min
-- later) before becoming 'open' and actually alerting, so a device that
-- just connected and hasn't generated traffic yet doesn't fire a false
-- positive on the very first check.
CREATE TABLE filter_bypass_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  device_key       TEXT NOT NULL,
  mac              TEXT,
  last_ip          INET,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'resolved')),
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at     TIMESTAMPTZ,
  last_checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  detail           JSONB
);

CREATE INDEX idx_filter_bypass_student ON filter_bypass_alerts(student_id, last_checked_at DESC);
CREATE INDEX idx_filter_bypass_open ON filter_bypass_alerts(device_key) WHERE status IN ('pending', 'open');
