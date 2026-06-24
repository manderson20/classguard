-- Append-only audit trail for teacher impersonation ("view as" sessions
-- admins use to troubleshoot on a teacher's behalf without their
-- password). Same rationale and tamper-proofing as device_view_audit
-- (migration 051): this is the accountability backstop for a capability
-- that could otherwise be used to act as someone else with no record of
-- it, so it has to survive someone with admin access to ClassGuard
-- itself trying to cover their tracks.
--
-- admin/teacher email+name are denormalized snapshots (not just a FK) so
-- the record of WHO acted as WHOM survives either account later being
-- deleted. session_id ties together one 'started' row, any number of
-- 'request' rows (one per mutating call made while impersonating), and
-- one 'ended' row -- 'request' rows leave teacher_name NULL since the
-- 'started' row in the same session already has it.
CREATE TABLE impersonation_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL,
  admin_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_email   VARCHAR(255) NOT NULL,
  admin_name    VARCHAR(255),
  teacher_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  teacher_email VARCHAR(255) NOT NULL,
  teacher_name  VARCHAR(255),
  action        VARCHAR(20) NOT NULL CHECK (action IN ('started', 'ended', 'request')),
  method        VARCHAR(10),
  path          VARCHAR(500),
  detail        JSONB,
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_impersonation_audit_session ON impersonation_audit (session_id, created_at);
CREATE INDEX idx_impersonation_audit_admin   ON impersonation_audit (admin_id, created_at DESC);
CREATE INDEX idx_impersonation_audit_teacher ON impersonation_audit (teacher_id, created_at DESC);

-- Same BEFORE-trigger tamper guard as device_view_audit_no_tamper -- see
-- that migration's comment for exactly what this does and doesn't
-- guarantee (blocks UPDATE/DELETE through the app and through ordinary
-- direct DB access; cannot stop someone who'd drop the trigger itself).
CREATE OR REPLACE FUNCTION prevent_impersonation_audit_tamper() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'impersonation_audit is append-only — % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER impersonation_audit_no_tamper
  BEFORE UPDATE OR DELETE ON impersonation_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_impersonation_audit_tamper();
