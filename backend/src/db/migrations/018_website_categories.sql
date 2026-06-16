-- Migration 018: Website category taxonomy for DNS content filtering

CREATE TABLE IF NOT EXISTS website_categories (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                VARCHAR(50)  UNIQUE NOT NULL,
  name                VARCHAR(100) NOT NULL,
  description         TEXT,
  risk_level          VARCHAR(10)  NOT NULL DEFAULT 'low' CHECK (risk_level IN ('high','medium','low')),
  is_blocked_default  BOOLEAN      DEFAULT false,
  sort_order          SMALLINT     DEFAULT 0,
  created_at          TIMESTAMPTZ  DEFAULT NOW()
);

-- Domain → category mapping (Postgres is source of truth; Redis is the fast-path cache)
CREATE TABLE IF NOT EXISTS domain_categories (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  domain       VARCHAR(253) NOT NULL,
  category_id  UUID         NOT NULL REFERENCES website_categories(id) ON DELETE CASCADE,
  source       VARCHAR(20)  NOT NULL DEFAULT 'manual'
                            CHECK (source IN ('ut1','shallalist','keyword','manual')),
  confidence   SMALLINT     NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  is_override  BOOLEAN      DEFAULT false,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (domain, category_id)
);

CREATE INDEX IF NOT EXISTS idx_domain_categories_domain ON domain_categories(domain);
CREATE INDEX IF NOT EXISTS idx_domain_categories_cat    ON domain_categories(category_id);

-- Per-policy category rules (block / allow / monitor)
CREATE TABLE IF NOT EXISTS policy_category_rules (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id    UUID        NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  category_id  UUID        NOT NULL REFERENCES website_categories(id) ON DELETE CASCADE,
  action       VARCHAR(10) NOT NULL CHECK (action IN ('block','allow','monitor')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (policy_id, category_id)
);

-- Source list registry (tracks last sync per list)
CREATE TABLE IF NOT EXISTS category_sources (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         VARCHAR(50)  UNIQUE NOT NULL,
  name         VARCHAR(100) NOT NULL,
  url          TEXT         NOT NULL,
  is_active    BOOLEAN      DEFAULT true,
  last_synced_at  TIMESTAMPTZ,
  domain_count    INT       DEFAULT 0,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Seed: category taxonomy (K-12 appropriate)
-- ---------------------------------------------------------------------------
INSERT INTO website_categories (slug, name, description, risk_level, is_blocked_default, sort_order) VALUES
  ('adult',        'Adult / Pornography', 'Sexually explicit content',              'high',   true,  1),
  ('violence',     'Violence / Gore',     'Graphic violence and gore',              'high',   true,  2),
  ('weapons',      'Weapons',             'Firearms, ammunition, explosives',       'high',   true,  3),
  ('gambling',     'Gambling',            'Online casinos, sports betting',         'high',   true,  4),
  ('drugs_alcohol','Drugs & Alcohol',     'Drug use, alcohol, tobacco',             'high',   true,  5),
  ('hate_speech',  'Hate Speech',         'Extremist and discriminatory content',   'high',   true,  6),
  ('phishing',     'Phishing / Fraud',    'Credential theft, scams, fraud',         'high',   true,  7),
  ('malware',      'Malware / Hacking',   'Malware, hacking tools, botnets',        'high',   true,  8),
  ('proxy_vpn',    'Proxy / VPN',         'Circumvention and anonymization tools',  'medium', false, 9),
  ('torrent',      'Torrent / P2P',       'File sharing and piracy',                'medium', false, 10),
  ('dating',       'Dating',              'Online dating services',                  'medium', false, 11),
  ('social_media', 'Social Media',        'Facebook, Instagram, TikTok, Snapchat', 'medium', false, 12),
  ('gaming',       'Gaming',              'Online games and gaming platforms',      'low',    false, 13),
  ('streaming',    'Streaming / Video',   'Netflix, YouTube, Twitch, Hulu',         'low',    false, 14),
  ('messaging',    'Messaging / Chat',    'Discord, WhatsApp, Telegram',            'low',    false, 15),
  ('forums',       'Forums / Boards',     'Reddit, forums, message boards',         'low',    false, 16),
  ('shopping',     'Shopping',            'E-commerce and retail',                  'low',    false, 17),
  ('news',         'News / Media',        'News and journalism sites',              'low',    false, 18),
  ('sports',       'Sports',              'Sports news and scores',                 'low',    false, 19),
  ('health',       'Health',              'Medical and health information',         'low',    false, 20),
  ('finance',      'Finance',             'Banking, investing, cryptocurrency',     'low',    false, 21),
  ('education',    'Education',           'Educational and academic content',       'low',    false, 22),
  ('search',       'Search Engines',      'Google, Bing, DuckDuckGo',              'low',    false, 23),
  ('ads_tracking', 'Ads & Tracking',      'Advertising networks and analytics',     'low',    false, 24),
  ('other',        'Other',               'Uncategorized content',                  'low',    false, 25)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: known category sources
-- ---------------------------------------------------------------------------
INSERT INTO category_sources (slug, name, url, is_active) VALUES
  ('ut1',       'UT1 Blacklists (Université Toulouse)',  'https://dsi.ut-capitole.fr/blacklists/download/blacklists.tar.gz', true),
  ('shallalist','Shallalist',                            'https://www.shallalist.de/Downloads/shallalist.tar.gz',            true)
ON CONFLICT (slug) DO NOTHING;
