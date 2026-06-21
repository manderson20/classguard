-- Append-only audit trail for anyone viewing a student's screenshots or
-- live browser view. This is the accountability backstop for monitoring
-- features that could otherwise be misused to spy on a specific student
-- with no record of it ever happening — so it has to survive someone
-- with admin access to ClassGuard itself trying to cover their tracks.
--
-- viewer/student email+name are denormalized snapshots (not just a FK) so
-- the record of WHO looked at WHOM survives a user account later being
-- deleted — an audit log that goes blank the moment the subject is
-- removed defeats its own purpose.
CREATE TABLE device_view_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  viewer_email  VARCHAR(255) NOT NULL,
  viewer_name   VARCHAR(255),
  student_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  student_email VARCHAR(255) NOT NULL,
  student_name  VARCHAR(255),
  action        VARCHAR(30) NOT NULL CHECK (action IN (
                  'live_view_started', 'live_view_stopped',
                  'screenshot_viewed', 'screenshot_list_viewed'
                )),
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_device_view_audit_student ON device_view_audit (student_id, created_at DESC);
CREATE INDEX idx_device_view_audit_viewer  ON device_view_audit (viewer_id, created_at DESC);

-- Hard block on UPDATE/DELETE via a trigger, not a GRANT/REVOKE - the app's
-- own DB role (classguard) is provisioned as a Postgres superuser by the
-- official Postgres Docker image, which bypasses ACL checks entirely
-- (verified empirically: REVOKE on this table had zero effect on that
-- role). A BEFORE trigger is the one mechanism that still fires
-- unconditionally regardless of role privileges.
--
-- Be precise about what this does and doesn't guarantee: through the app
-- itself, there is no route that issues UPDATE/DELETE on this table at
-- all. Through ordinary direct database access (psql with the app's own
-- credentials), a plain UPDATE/DELETE statement is blocked outright by
-- this trigger. The one thing it cannot stop is someone who already has
-- those credentials deliberately running DROP TRIGGER first - no
-- single-role database can fully close that door, since classguard is a
-- superuser. That is the honest limit here, not "this table is impossible
-- to alter under any circumstances."
CREATE OR REPLACE FUNCTION prevent_device_view_audit_tamper() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'device_view_audit is append-only — % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER device_view_audit_no_tamper
  BEFORE UPDATE OR DELETE ON device_view_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_device_view_audit_tamper();
