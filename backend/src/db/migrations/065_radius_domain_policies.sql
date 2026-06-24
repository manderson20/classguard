-- Lets a Wi-Fi policy match by email domain (e.g. deny students.<domain> on
-- a given SSID while staff at <domain> are allowed) instead of only by a
-- specific ClassGuard user_id/group_id. Exact-match on the domain part of
-- the email (the part after '@') -- "students.school.org" and "school.org"
-- are treated as two distinct domains, not a wildcard/subdomain match.
ALTER TABLE radius_user_policies ADD COLUMN IF NOT EXISTS email_domain TEXT;
