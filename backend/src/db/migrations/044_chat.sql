-- Teacher Live View Phase 2: chat. Two persisted shapes only — 'direct'
-- (teacher + one student, reused across sends) and 'group' (teacher + many
-- students, all visible to each other). "Broadcast" (message several
-- students privately at once) is not a stored type — it's the application
-- layer finding-or-creating one 'direct' thread per recipient and inserting
-- the same body into each, so each recipient only ever sees their own
-- thread.
--
-- Deletion is always soft (deleted_at/deleted_by) — admin must be able to
-- see every message ever exchanged, including ones a participant deleted,
-- so the row is never actually removed.
CREATE TABLE IF NOT EXISTS chat_threads (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type        VARCHAR(10) NOT NULL CHECK (type IN ('direct', 'group')),
  name        VARCHAR(255),
  class_id    UUID        REFERENCES classes(id) ON DELETE SET NULL,
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS chat_thread_members (
  thread_id    UUID        NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         VARCHAR(10) NOT NULL CHECK (role IN ('teacher', 'student')),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_thread_members_user ON chat_thread_members(user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   UUID        NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID        REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);
