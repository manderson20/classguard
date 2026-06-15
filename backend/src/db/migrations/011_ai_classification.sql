-- AI domain classification and global allowlist override

CREATE TABLE IF NOT EXISTS domain_classifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain         TEXT NOT NULL UNIQUE,
  category       TEXT,                          -- e.g. 'education', 'social_media', 'gaming'
  is_educational BOOLEAN NOT NULL DEFAULT false,
  is_productive  BOOLEAN NOT NULL DEFAULT false,
  is_time_wasting BOOLEAN NOT NULL DEFAULT false,
  confidence     NUMERIC(4,3),                  -- 0.000–1.000
  classified_by  TEXT NOT NULL DEFAULT 'manual',-- 'claude','openai','ollama','manual'
  reasoning      TEXT,                          -- brief AI explanation (no PII)
  classified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ                    -- NULL = permanent; set for periodic re-check
);

CREATE INDEX IF NOT EXISTS idx_dc_domain ON domain_classifications(domain);
CREATE INDEX IF NOT EXISTS idx_dc_category ON domain_classifications(category);

-- Global domain allowlist — overrides ALL blocks including lesson mode
-- Sources: managed_bookmarks (Google Admin), manual (admin-added)
CREATE TABLE IF NOT EXISTS allowlist_overrides (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain     TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL DEFAULT 'manual', -- 'managed_bookmarks','manual','ai_suggested'
  notes      TEXT,
  added_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ao_domain ON allowlist_overrides(domain);
CREATE INDEX IF NOT EXISTS idx_ao_source ON allowlist_overrides(source);
