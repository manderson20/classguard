-- Multiple VPN access profiles, each with its own subnet restriction,
-- assigned to a user or group -- same shape as radius_user_policies'
-- user_id/group_id precedence (014/065). Resolved from the connecting
-- cert's CN, which every documented enrollment path on the VPN page
-- already sets to the connecting user's real email (Mosyle's
-- "CN=%Email%", Intune's "CN={{UserPrincipalName}}", the manual Windows
-- script's "$env:USERNAME@$env:USERDNSDOMAIN") -- so this reuses identity
-- ClassGuard already has, no MDM-side change required.
CREATE TABLE IF NOT EXISTS vpn_profiles (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(255) NOT NULL,
  is_default          BOOLEAN      NOT NULL DEFAULT false,
  restrict_to_subnets CIDR[]       NOT NULL DEFAULT '{}',
  created_by          UUID         REFERENCES users(id),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Exactly one default profile at a time -- the catch-all for anyone not
-- otherwise assigned.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vpn_profiles_one_default
  ON vpn_profiles (is_default) WHERE is_default;

-- Seed a Default profile, carrying over whatever restrict_to_subnets the
-- old singleton config already had, so existing deployments don't silently
-- lose a restriction they'd already set.
INSERT INTO vpn_profiles (name, is_default, restrict_to_subnets)
SELECT 'Default', true, COALESCE(restrict_to_subnets, '{}')
FROM vpn_config LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO vpn_profiles (name, is_default)
SELECT 'Default', true
WHERE NOT EXISTS (SELECT 1 FROM vpn_profiles WHERE is_default);

ALTER TABLE vpn_config DROP COLUMN IF EXISTS restrict_to_subnets;

-- Assignment: a non-default profile applies to one specific user, or to
-- everyone in one group. A user/group can carry at most one direct
-- assignment (the partial unique indexes below) -- reassigning means
-- moving the row, not adding a second one.
CREATE TABLE IF NOT EXISTS vpn_profile_assignments (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID        NOT NULL REFERENCES vpn_profiles(id) ON DELETE CASCADE,
  user_id    UUID        REFERENCES users(id)  ON DELETE CASCADE,
  group_id   UUID        REFERENCES groups(id) ON DELETE CASCADE,
  created_by UUID        REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vpn_assignment_user_or_group CHECK (
    (user_id IS NOT NULL AND group_id IS NULL) OR (user_id IS NULL AND group_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vpn_profile_assignments_user
  ON vpn_profile_assignments (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vpn_profile_assignments_group
  ON vpn_profile_assignments (group_id) WHERE group_id IS NOT NULL;

-- Record which profile each session actually resolved to, for visibility
-- in the Sessions table.
ALTER TABLE vpn_clients ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES vpn_profiles(id);
