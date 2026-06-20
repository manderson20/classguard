-- Migration 039: DNS-level network floor policy + extension-only URL-path rules.
--
-- DNS can only ever see a domain, never a URL path — so anything GoGuardian-style
-- path-specific (e.g. youtube.com/watch?v=X) can only be enforced by the
-- extension (which sees full URLs). policy_url_rules holds those patterns,
-- stored ready-to-use as chrome.declarativeNetRequest urlFilter strings.
--
-- is_network_policy (mirrors the existing is_default pattern) designates one
-- policy as the network-wide DNS floor: always enforced for every query
-- regardless of identity, on top of which a student/staff member's OU-level
-- extension policy can only add further restrictions, never remove the floor.

ALTER TABLE policies ADD COLUMN IF NOT EXISTS is_network_policy BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_one_network_policy
  ON policies ((true)) WHERE is_network_policy = true;

CREATE TABLE IF NOT EXISTS policy_url_rules (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id  UUID        NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  pattern    TEXT        NOT NULL,   -- declarativeNetRequest urlFilter syntax
  rule_type  TEXT        NOT NULL CHECK (rule_type IN ('allow','deny')),
  source     TEXT        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','goguardian_import')),
  added_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (policy_id, pattern)
);

CREATE INDEX IF NOT EXISTS idx_policy_url_rules_policy ON policy_url_rules(policy_id);
