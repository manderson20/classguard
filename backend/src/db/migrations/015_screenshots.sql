-- Migration 015: Screenshot capture and storage
-- Screenshots are stored as files on disk; this table holds metadata only.

CREATE TABLE IF NOT EXISTS screenshots (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url           TEXT        NOT NULL,
  page_title    TEXT,
  trigger       TEXT        NOT NULL
                            CHECK (trigger IN ('teacher_request','content_violation',
                                               'policy_block','manual')),
  trigger_detail TEXT,      -- keyword matched, teacher name, etc.
  file_path     TEXT        NOT NULL,
  file_size     INTEGER,
  ai_flagged    BOOLEAN,
  ai_category   TEXT,       -- 'violence','adult','self_harm','profanity','other'
  ai_confidence NUMERIC(4,3),
  ai_reasoning  TEXT,
  reviewed_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screenshots_student  ON screenshots(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_screenshots_flagged  ON screenshots(ai_flagged, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_screenshots_trigger  ON screenshots(trigger, created_at DESC);

-- Retention: auto-delete after configured days (default 30)
-- Background job reads dns_log_retention_days or screenshot_retention_days setting.

-- Blocked keyword list for in-extension content scanning
-- (checked in the content script without sending page text to the server)
CREATE TABLE IF NOT EXISTS content_keywords (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword    TEXT        NOT NULL UNIQUE,
  category   TEXT        NOT NULL DEFAULT 'profanity',
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  added_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a minimal starter set; admins add more in the UI
INSERT INTO content_keywords (keyword, category) VALUES
  ('pornhub',      'adult'),
  ('xvideos',      'adult'),
  ('onlyfans',     'adult'),
  ('chaturbate',   'adult')
ON CONFLICT (keyword) DO NOTHING;
