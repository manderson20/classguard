-- group_type: distinguish Google Workspace groups (synced read-only),
-- manually created admin groups, and filter groups (penalty-box-style
-- groups with an assigned filter policy for students needing extra restrictions).
ALTER TABLE groups ADD COLUMN IF NOT EXISTS group_type VARCHAR(20) NOT NULL DEFAULT 'manual';

-- Backfill: any group that was synced from Google Workspace already has
-- google_group_email set; mark those as 'google' so the UI can label them.
UPDATE groups SET group_type = 'google' WHERE google_group_email IS NOT NULL AND group_type = 'manual';

-- default_action: per-policy filtering stance.
--   'allow' (default) = allow everything except what's blocked (current behavior)
--   'block'           = block everything except what's explicitly in the allowlist
-- Only meaningful when mode = 'standard'; ignored in 'open'/'lesson'/'penalty_box'.
ALTER TABLE policies ADD COLUMN IF NOT EXISTS default_action VARCHAR(10) NOT NULL DEFAULT 'allow';
