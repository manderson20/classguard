-- Migration 023: Per-policy YouTube individual video allow/block rules

CREATE TABLE IF NOT EXISTS youtube_video_rules (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id     UUID         NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  video_id      VARCHAR(30)  NOT NULL,
  action        VARCHAR(10)  NOT NULL CHECK (action IN ('allow', 'block')),
  title         TEXT,
  channel_title TEXT,
  thumbnail_url TEXT,
  category_id   SMALLINT,
  category_name VARCHAR(100),
  added_by      UUID         REFERENCES users(id),
  added_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (policy_id, video_id)
);

CREATE INDEX IF NOT EXISTS youtube_video_rules_policy_idx
  ON youtube_video_rules (policy_id, action);
