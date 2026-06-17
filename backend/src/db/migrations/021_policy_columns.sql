-- Migration 021: Fix policies schema + add missing columns

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS is_default        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS block_page_message TEXT;

-- Rename safe_search_enforced → safe_search if the old name exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'policies' AND column_name = 'safe_search_enforced'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'policies' AND column_name = 'safe_search'
  ) THEN
    ALTER TABLE policies RENAME COLUMN safe_search_enforced TO safe_search;
  END IF;
END$$;

-- Ensure safe_search column exists (may already be there under the right name)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'policies' AND column_name = 'safe_search'
  ) THEN
    ALTER TABLE policies ADD COLUMN safe_search BOOLEAN DEFAULT true;
  END IF;
END$$;

-- Ensure youtube_restricted is varchar (already is, but normalise just in case)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'policies' AND column_name = 'youtube_restricted'
      AND data_type = 'boolean'
  ) THEN
    ALTER TABLE policies
      ALTER COLUMN youtube_restricted TYPE VARCHAR(20)
      USING CASE WHEN youtube_restricted THEN 'moderate' ELSE 'off' END;
  END IF;
END$$;

-- Backfill is_default from the settings table
UPDATE policies p
SET    is_default = true
FROM   settings s
WHERE  s.key = 'default_policy_id'
  AND  s.value = p.id::text;

-- Ensure policy_domain_rules has ON CONFLICT target (unique on policy+domain)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'policy_domain_rules_policy_domain_unique'
  ) THEN
    ALTER TABLE policy_domain_rules
      ADD CONSTRAINT policy_domain_rules_policy_domain_unique
      UNIQUE (policy_id, domain);
  END IF;
END$$;
