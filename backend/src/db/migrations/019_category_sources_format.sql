-- Migration 019: extend category_sources with format + origin, seed new plain-list sources

-- Add format, default_category_slug, and origin columns
ALTER TABLE category_sources
  ADD COLUMN IF NOT EXISTS format                VARCHAR(20)  NOT NULL DEFAULT 'tarball',
  ADD COLUMN IF NOT EXISTS default_category_slug VARCHAR(50),
  ADD COLUMN IF NOT EXISTS origin                VARCHAR(100);

-- Ensure existing tarball sources are marked correctly
UPDATE category_sources SET format = 'tarball' WHERE format IS NULL OR format = '';

-- Drop the hard-coded CHECK on domain_categories.source so arbitrary source slugs are valid
ALTER TABLE domain_categories DROP CONSTRAINT IF EXISTS domain_categories_source_check;

-- Widen source column to accommodate longer slugs (e.g. 'hagezi_threat')
ALTER TABLE domain_categories
  ALTER COLUMN source TYPE VARCHAR(50);

-- ---------------------------------------------------------------------------
-- New sources: plain domain/URL lists
-- ---------------------------------------------------------------------------
INSERT INTO category_sources (slug, name, url, format, default_category_slug, origin, is_active)
VALUES
  -- Hagezi DNS Blocklists (Germany) — highly maintained, GitHub-hosted via jsDelivr CDN
  ('hagezi_adult',
   'Hagezi Adult Blocklist',
   'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/adult.txt',
   'plain_list', 'adult', 'Germany (EU)', true),

  ('hagezi_threat',
   'Hagezi Multi Threat Intelligence',
   'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/multi.txt',
   'plain_list', 'malware', 'Germany (EU)', true),

  -- URLhaus — active malware delivery and C2 domains (abuse.ch, Switzerland)
  ('urlhaus',
   'URLhaus Active Malware Domains (abuse.ch)',
   'https://urlhaus.abuse.ch/downloads/text_online/',
   'plain_list', 'malware', 'Switzerland (EU)', true),

  -- OpenPhish — phishing URL feed (USA)
  ('openphish',
   'OpenPhish Phishing Feed',
   'https://openphish.com/feed.txt',
   'plain_list', 'phishing', 'USA', true)

ON CONFLICT (slug) DO NOTHING;
