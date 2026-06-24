-- Unifies the hardcoded role strings (student/teacher/admin/superadmin)
-- with the custom_roles permission system, instead of leaving them as
-- labels with no associated, manageable permission set. Super Admin is
-- seeded with every permission key but flagged is_locked so it can never
-- be weakened (it stays enforced via the existing role==='superadmin'
-- bypass in services/permissions.js regardless of what this row says --
-- the row exists for visibility/consistency, not as the enforcement path).
-- Admin keeps today's default (every key, i.e. unrestricted) but is now an
-- editable, real role. Teacher has no permission keys of its own yet (none
-- exist in the catalog) -- this just gives it a real, editable row ready
-- for teacher-specific keys as they're added.
ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS is_locked  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS base_role  VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_base_role_uniq ON custom_roles(base_role) WHERE base_role IS NOT NULL;

INSERT INTO custom_roles (name, description, is_builtin, is_locked, base_role)
SELECT v.name, v.description, true, v.is_locked, v.base_role
FROM (VALUES
  ('Super Admin', 'Always has every permission. Locked so it can''t be edited or weakened.', true,  'superadmin'),
  ('Admin',       'Full admin access by default. Editable -- narrow what admins can do.',    false, 'admin'),
  ('Teacher',     'Default teacher access. Editable as teacher-specific permissions are added going forward.', false, 'teacher')
) AS v(name, description, is_locked, base_role)
WHERE NOT EXISTS (SELECT 1 FROM custom_roles WHERE base_role = v.base_role);

-- Seed Super Admin and Admin with the full permission catalog as it exists
-- today (a one-time snapshot, same semantics a custom role already has --
-- it doesn't retroactively gain newly-added keys, exactly like any
-- existing custom role wouldn't either).
INSERT INTO custom_role_permissions (role_id, permission_key)
SELECT cr.id, k
FROM custom_roles cr
CROSS JOIN (VALUES
  ('staff_analytics'),('users'),('classes'),('policies'),('groups'),('blocklists'),
  ('categories'),('screenshots'),('browser_history'),('chat_audit'),('device_view_audit'),
  ('ai_classifier'),('unblock_requests'),('safety_alerts'),('dns_logs'),('dns_records'),
  ('radius'),('ipam'),('dhcp'),('network'),('phones'),('roster'),('bell_schedule'),
  ('integrations'),('ha_monitoring'),('vpn_config'),('ipv6_config'),('ntp_monitoring'),
  ('system_health'),('internet_monitoring'),('settings')
) AS p(k)
WHERE cr.base_role IN ('superadmin', 'admin')
ON CONFLICT DO NOTHING;

-- Backfill: existing admin-tier users with no custom role assigned now
-- point at the matching builtin row, so editing that row actually affects
-- them. Anyone who already has a real custom role keeps it untouched.
UPDATE users u SET custom_role_id = cr.id
FROM custom_roles cr
WHERE cr.base_role = u.role AND u.custom_role_id IS NULL
  AND u.role IN ('superadmin', 'admin', 'teacher');
