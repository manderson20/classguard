-- Chromebook Auto-Update Policy reference (model → AUP expiration date)
-- Pre-seeded with common school Chromebook models. Admin can add/edit via Fleet UI.
CREATE TABLE IF NOT EXISTS chromebook_aup_reference (
  id         SERIAL PRIMARY KEY,
  model      TEXT NOT NULL UNIQUE,
  aup_date   DATE,
  notes      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Apple OS latest-version reference (admin-updateable via Fleet > Apple Devices)
CREATE TABLE IF NOT EXISTS apple_os_reference (
  id                    SERIAL PRIMARY KEY,
  os_family             TEXT NOT NULL UNIQUE, -- macOS | iOS | iPadOS | tvOS
  latest_version        TEXT NOT NULL,
  min_supported_version TEXT,
  notes                 TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cross-system sync run log
CREATE TABLE IF NOT EXISTS fleet_sync_log (
  id                   SERIAL PRIMARY KEY,
  run_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_in_snipeit   INTEGER NOT NULL DEFAULT 0,
  wrote_back_to_mosyle INTEGER NOT NULL DEFAULT 0,
  wrote_back_to_google INTEGER NOT NULL DEFAULT 0,
  skipped              INTEGER NOT NULL DEFAULT 0,
  errors               TEXT[],
  triggered_by         UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Seed Chromebook AUP reference data (Google's published Auto-Update Expiry list)
INSERT INTO chromebook_aup_reference (model, aup_date) VALUES
  ('HP Chromebook 11 G6 EE',             '2024-06-01'),
  ('HP Chromebook 11 G7 EE',             '2024-06-01'),
  ('HP Chromebook 11 G8 EE',             '2026-06-01'),
  ('HP Chromebook 11 G9 EE',             '2028-06-01'),
  ('HP Chromebook 14 G6',                '2026-06-01'),
  ('HP Chromebook 14 G7',                '2028-06-01'),
  ('HP Chromebook x360 11 G3 EE',        '2026-06-01'),
  ('HP Chromebook x360 11 G4 EE',        '2028-06-01'),
  ('Lenovo 100e Chromebook 2nd Gen',     '2025-06-01'),
  ('Lenovo 300e Chromebook 2nd Gen',     '2026-06-01'),
  ('Lenovo 500e Chromebook 2nd Gen',     '2026-06-01'),
  ('Lenovo 100e Chromebook 3rd Gen',     '2028-06-01'),
  ('Lenovo 300e Chromebook 3rd Gen',     '2028-06-01'),
  ('Lenovo 500e Chromebook 3rd Gen',     '2029-06-01'),
  ('Lenovo Flex 3i Chromebook',          '2028-06-01'),
  ('Lenovo IdeaPad Flex 5i Chromebook',  '2029-06-01'),
  ('Dell Chromebook 3100',               '2026-06-01'),
  ('Dell Chromebook 3100 2-in-1',        '2026-06-01'),
  ('Dell Chromebook 3110',               '2029-06-01'),
  ('Dell Chromebook 3110 2-in-1',        '2029-06-01'),
  ('Dell Chromebook 5190',               '2024-06-01'),
  ('Acer Chromebook 311',                '2026-06-01'),
  ('Acer Chromebook 511',                '2028-06-01'),
  ('Acer Chromebook 512',                '2026-06-01'),
  ('Acer Chromebook 712',                '2026-06-01'),
  ('Acer Chromebook Spin 311',           '2026-06-01'),
  ('Acer Chromebook Spin 511',           '2028-06-01'),
  ('Acer Chromebook Spin 512',           '2026-06-01'),
  ('ASUS Chromebook C204MA',             '2026-06-01'),
  ('ASUS Chromebook C214MA',             '2026-06-01'),
  ('ASUS Chromebook Flip C214MA',        '2026-06-01'),
  ('ASUS Chromebook CX1',                '2028-06-01'),
  ('ASUS Chromebook Flip CX1',           '2028-06-01'),
  ('ASUS Chromebook CR1',                '2028-06-01'),
  ('Samsung Chromebook 4',               '2026-06-01'),
  ('Samsung Chromebook 4+',              '2026-06-01'),
  ('CTL Chromebook NL7',                 '2025-06-01'),
  ('CTL Chromebook NL7T',                '2026-06-01'),
  ('CTL Chromebook VX11',                '2028-06-01'),
  ('Poin2 Chromebook 11C',               '2026-06-01')
ON CONFLICT (model) DO NOTHING;

-- Seed Apple OS reference (admin should update when Apple releases new versions)
INSERT INTO apple_os_reference (os_family, latest_version, min_supported_version, notes) VALUES
  ('macOS',   '15.0', '13.0', 'Update when Apple releases new macOS — check apple.com/macos'),
  ('iOS',     '18.0', '16.0', 'Update when Apple releases new iOS — check apple.com/ios'),
  ('iPadOS',  '18.0', '16.0', 'Update when Apple releases new iPadOS — check apple.com/ipados'),
  ('tvOS',    '18.0', '16.0', 'Update when Apple releases new tvOS')
ON CONFLICT (os_family) DO NOTHING;
