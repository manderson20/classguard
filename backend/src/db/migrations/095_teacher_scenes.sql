-- Teacher Scenes: named, reusable allowed-website lists a teacher builds once
-- and applies when starting a lesson (GoGuardian "Scenes" equivalent). These
-- layer on top of the district-wide filter via the existing lesson focus
-- mechanism (lesson_sessions.allowed_domains) — no new enforcement path.
CREATE TABLE IF NOT EXISTS teacher_scenes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  allowed_domains JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (teacher_id, name)
);

CREATE INDEX IF NOT EXISTS idx_teacher_scenes_teacher ON teacher_scenes(teacher_id);
