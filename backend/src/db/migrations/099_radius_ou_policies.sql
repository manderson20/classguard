-- Lets a Wi-Fi policy match by Google OU path (e.g. allow /Employees and
-- /Students/High School on the BYOD SSID while /Students/Withdrawn or
-- Graduated is denied). Subtree match: a policy for "/Students" also covers
-- "/Students/High School/11th Grade". Matched against users.google_ou, so it
-- only applies to accounts synced from Google Admin — unlike email_domain
-- rules it cannot gate accounts ClassGuard has never seen.
ALTER TABLE radius_user_policies ADD COLUMN IF NOT EXISTS google_ou TEXT;
