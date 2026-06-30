-- ClassPulse: interactive classroom instruction and formative assessment module.
-- Teachers create lessons (pages + questions), start sessions, and students
-- join via a 6-character code. Real-time responses flow over socket.io rooms.

CREATE TABLE classpulse_lessons (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               TEXT        NOT NULL,
  description         TEXT,
  subject             TEXT,
  grade_level         TEXT,
  class_id            UUID        REFERENCES classes(id) ON DELETE SET NULL,
  status              TEXT        NOT NULL DEFAULT 'draft',
  -- draft | published | archived
  estimated_minutes   INTEGER,
  tags                TEXT[]      NOT NULL DEFAULT '{}',
  folder              TEXT,
  shared              BOOLEAN     NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE classpulse_pages (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id            UUID        NOT NULL REFERENCES classpulse_lessons(id) ON DELETE CASCADE,
  position             INTEGER     NOT NULL,
  content_type         TEXT        NOT NULL DEFAULT 'content',
  -- content | question | exit_ticket
  title                TEXT,
  body                 TEXT,
  teacher_notes        TEXT,
  student_instructions TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(lesson_id, position)
);

CREATE TABLE classpulse_questions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       UUID        NOT NULL REFERENCES classpulse_pages(id) ON DELETE CASCADE,
  question_type TEXT        NOT NULL,
  -- MVP: multiple_choice | short_answer | true_false | exit_ticket
  -- Later: paragraph | numeric | rating | emoji_mood | yes_no | drawing | annotation
  prompt        TEXT        NOT NULL,
  settings      JSONB       NOT NULL DEFAULT '{}',
  -- e.g. { "anonymous": true, "required": true, "max_chars": 500 }
  position      INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE classpulse_question_options (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID    NOT NULL REFERENCES classpulse_questions(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  is_correct  BOOLEAN NOT NULL DEFAULT false,
  position    INTEGER NOT NULL,
  UNIQUE(question_id, position)
);

CREATE TABLE classpulse_sessions (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id              UUID        REFERENCES classpulse_lessons(id) ON DELETE SET NULL,
  teacher_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id               UUID        REFERENCES classes(id) ON DELETE SET NULL,
  join_code              TEXT        NOT NULL UNIQUE,
  mode                   TEXT        NOT NULL DEFAULT 'teacher_paced',
  -- teacher_paced | student_paced | exit_ticket | quick_question
  status                 TEXT        NOT NULL DEFAULT 'active',
  -- active | ended
  current_page_id        UUID        REFERENCES classpulse_pages(id) ON DELETE SET NULL,
  classroom_lock_enabled BOOLEAN     NOT NULL DEFAULT false,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at               TIMESTAMPTZ,
  teacher_comments       TEXT
);

CREATE TABLE classpulse_session_students (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID        NOT NULL REFERENCES classpulse_sessions(id) ON DELETE CASCADE,
  student_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_page_id UUID        REFERENCES classpulse_pages(id) ON DELETE SET NULL,
  status          TEXT        NOT NULL DEFAULT 'active',
  -- active | disconnected
  UNIQUE(session_id, student_id)
);

CREATE TABLE classpulse_responses (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES classpulse_sessions(id) ON DELETE CASCADE,
  question_id   UUID        NOT NULL REFERENCES classpulse_questions(id) ON DELETE CASCADE,
  student_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response_type TEXT        NOT NULL,
  -- text | choice | numeric | drawing
  text_value    TEXT,
  numeric_value NUMERIC,
  option_ids    UUID[]      NOT NULL DEFAULT '{}',
  drawing_data  TEXT,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_hidden     BOOLEAN     NOT NULL DEFAULT false,
  is_flagged    BOOLEAN     NOT NULL DEFAULT false,
  UNIQUE(session_id, question_id, student_id)
);

CREATE TABLE classpulse_flags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id UUID        NOT NULL REFERENCES classpulse_responses(id) ON DELETE CASCADE,
  teacher_id  UUID        REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE classpulse_lesson_shares (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id    UUID        NOT NULL REFERENCES classpulse_lessons(id) ON DELETE CASCADE,
  shared_by    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_with  UUID        REFERENCES users(id) ON DELETE CASCADE,
  -- NULL = school-wide share
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(lesson_id, shared_with)
);

-- Indexes for common query patterns
CREATE INDEX idx_classpulse_lessons_teacher  ON classpulse_lessons(teacher_id);
CREATE INDEX idx_classpulse_lessons_status   ON classpulse_lessons(status);
CREATE INDEX idx_classpulse_pages_lesson     ON classpulse_pages(lesson_id, position);
CREATE INDEX idx_classpulse_questions_page   ON classpulse_questions(page_id, position);
CREATE INDEX idx_classpulse_sessions_code    ON classpulse_sessions(join_code);
CREATE INDEX idx_classpulse_sessions_teacher ON classpulse_sessions(teacher_id, status);
CREATE INDEX idx_classpulse_session_students ON classpulse_session_students(session_id, status);
CREATE INDEX idx_classpulse_responses_session ON classpulse_responses(session_id, question_id);
CREATE INDEX idx_classpulse_shares_lesson    ON classpulse_lesson_shares(lesson_id);
CREATE INDEX idx_classpulse_shares_with      ON classpulse_lesson_shares(shared_with);

-- Auto-update updated_at on lessons
CREATE OR REPLACE FUNCTION classpulse_lessons_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER classpulse_lessons_updated_at
  BEFORE UPDATE ON classpulse_lessons
  FOR EACH ROW EXECUTE FUNCTION classpulse_lessons_updated_at();
