-- Migration 056: Safety Evidence Capture — rule-based risk scoring,
-- proactive (non-keyword) screenshot capture, and a review workflow.
--
-- self_harm was the one glaring gap in the category taxonomy: violence,
-- weapons, adult, gambling, drugs_alcohol, hate_speech were all already
-- blocked-by-default, but nothing covered self-harm/suicide content at all.
INSERT INTO website_categories (slug, name, description, risk_level, is_blocked_default, sort_order) VALUES
  ('self_harm', 'Self-Harm / Suicide', 'Self-harm, suicide, and related at-risk content', 'high', true, 0)
ON CONFLICT (slug) DO NOTHING;

-- content_keywords had only 4 adult-content terms total and no seed
-- coverage for any other category, despite the schema supporting any
-- category. This is the actual signal the in-page text scanner runs on,
-- so a thin list meant the scanner was doing almost nothing outside porn
-- site names. Admins can add more via the new keyword management UI.
INSERT INTO content_keywords (keyword, category) VALUES
  ('kill myself',        'self_harm'),
  ('suicidal',           'self_harm'),
  ('suicide methods',    'self_harm'),
  ('want to die',        'self_harm'),
  ('self harm',          'self_harm'),
  ('cutting myself',     'self_harm'),
  ('how to overdose',    'self_harm'),
  ('school shooting',    'violence'),
  ('mass shooting',      'violence'),
  ('gore site',          'violence'),
  ('beheading video',    'violence'),
  ('buy a gun online',   'weapons'),
  ('ghost gun',          'weapons'),
  ('how to make a bomb', 'weapons'),
  ('weed delivery',      'drugs_alcohol'),
  ('buy fake id',        'drugs_alcohol'),
  ('how to get high',    'drugs_alcohol'),
  ('fentanyl',           'drugs_alcohol'),
  ('white power',        'hate_speech'),
  ('racial slurs list',  'hate_speech'),
  ('online casino',      'gambling'),
  ('sports betting',     'gambling'),
  ('free vpn unblock',   'proxy_vpn'),
  ('school proxy bypass','proxy_vpn'),
  ('unblock site proxy', 'proxy_vpn')
ON CONFLICT (keyword) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Screenshots: rule-based risk score + a real review workflow, replacing
-- the previous binary reviewed_by/reviewed_at with an actual ticket-style
-- status. AI vision analysis (ai_flagged etc.) stays as an optional extra
-- signal when a provider is configured — risk_score/risk_category is the
-- rule-based signal that works even with no AI configured at all.
-- ---------------------------------------------------------------------------
ALTER TABLE screenshots
  ADD COLUMN IF NOT EXISTS risk_score       SMALLINT,
  ADD COLUMN IF NOT EXISTS risk_category    TEXT,
  ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'new'
                                            CHECK (status IN ('new','in_review','resolved','dismissed')),
  ADD COLUMN IF NOT EXISTS assigned_to      UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alerted_at       TIMESTAMPTZ;

-- Backfill: a screenshot already marked reviewed under the old binary
-- scheme is the closest existing equivalent of "resolved".
UPDATE screenshots SET status = 'resolved', resolved_by = reviewed_by, resolved_at = reviewed_at
  WHERE reviewed_at IS NOT NULL AND status = 'new';

CREATE INDEX IF NOT EXISTS idx_screenshots_status ON screenshots(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_screenshots_risk   ON screenshots(risk_score DESC, created_at DESC);

-- 'risky_category' = proactive capture on a high-risk-or-uncategorized
-- domain that text-keyword scanning alone wouldn't have caught (e.g. an
-- image-heavy page that loaded clean text). Distinct from content_violation
-- (a text keyword match) and policy_block (kept for future use).
ALTER TABLE screenshots DROP CONSTRAINT IF EXISTS screenshots_trigger_check;
ALTER TABLE screenshots ADD CONSTRAINT screenshots_trigger_check
  CHECK (trigger IN ('teacher_request','content_violation','policy_block','risky_category','manual'));

-- Safety alert delivery — configurable per the project's "all integration
-- credentials live in the DB, never .env" convention. Comma-separated list
-- kept simple rather than a separate recipients table; this is a short,
-- rarely-changed staff list, not user-managed data.
INSERT INTO settings (key, value) VALUES
  ('smtp_host', ''),
  ('smtp_port', '587'),
  ('smtp_secure', 'false'),
  ('smtp_user', ''),
  ('smtp_password', ''),
  ('smtp_from', ''),
  ('safety_alert_emails', '')
ON CONFLICT (key) DO NOTHING;
