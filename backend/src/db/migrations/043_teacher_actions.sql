-- Audit log for teacher-initiated remote actions (lock/unlock screen,
-- open/close tab) on a student's device — accountability for an otherwise
-- invisible, privileged remote-control channel.
CREATE TABLE IF NOT EXISTS teacher_actions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID        REFERENCES users(id) ON DELETE SET NULL,
  student_id  UUID        REFERENCES users(id) ON DELETE SET NULL,
  class_id    UUID        REFERENCES classes(id) ON DELETE SET NULL,
  action_type VARCHAR(30) NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teacher_actions_student ON teacher_actions(student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_teacher_actions_teacher ON teacher_actions(teacher_id, created_at);
