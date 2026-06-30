const { query } = require('../db');
const redis      = require('../redis');

const PERMISSIONS_TTL = 60; // seconds — same TTL as policyResolver.js's POLICY_TTL
const UNRESTRICTED     = '*';

// One key per admin-tier feature area a custom role can grant/withhold.
// Deliberately excludes anything that's hardcoded superadmin-only today
// (role assignment, HA promote/VRRP/update-scheduling, VPN CA/key material,
// TLS issuance, IPv6/NTP server config, internal HA-replication bulk
// endpoints) — those stay un-delegatable regardless of this system.
// `sensitive: true` is UI-only (warns before granting), not an enforcement
// difference from any other key.
const PERMISSION_CATALOG = [
  { key: 'staff_analytics',  label: 'Staff Analytics',    section: 'Overview' },
  { key: 'users',            label: 'Users',              section: 'Overview' },
  { key: 'impersonate_users', label: 'Impersonate Teachers', section: 'Overview', sensitive: true },
  // No dedicated admin nav item — reached only via the Teacher-nav "My
  // Classes" page (Layout.jsx's nav switcher), which admins/superadmins can
  // always flip into. Still a real admin-tier capability (create/edit/
  // delete any class district-wide) that should be independently grantable.
  { key: 'classes',          label: 'Classes (admin create/edit/delete)', section: 'Overview' },
  { key: 'policies',         label: 'Policies',            section: 'Policies & Safety' },
  { key: 'groups',           label: 'Groups',              section: 'Policies & Safety' },
  { key: 'blocklists',       label: 'Blocklists',          section: 'Policies & Safety' },
  { key: 'categories',       label: 'Categories',          section: 'Policies & Safety' },
  { key: 'screenshots',      label: 'Screenshots',         section: 'Policies & Safety' },
  { key: 'browser_history',  label: 'Browser History',     section: 'Policies & Safety' },
  { key: 'chat_audit',       label: 'Chat Audit',          section: 'Policies & Safety' },
  { key: 'device_view_audit',label: 'Device View Audit',   section: 'Policies & Safety' },
  { key: 'ai_classifier',    label: 'AI Classifier',       section: 'Policies & Safety' },
  { key: 'unblock_requests', label: 'Unblock Requests',    section: 'Policies & Safety' },
  { key: 'safety_alerts',    label: 'Safety Alerts (Keywords & Alerting)', section: 'Policies & Safety' },
  { key: 'dns_logs',         label: 'DNS Logs',            section: 'DNS & Network' },
  { key: 'dns_records',      label: 'DNS Records',         section: 'DNS & Network' },
  { key: 'radius',           label: 'RADIUS / NAC',        section: 'DNS & Network' },
  { key: 'ipam',             label: 'IPAM',                 section: 'DNS & Network' },
  { key: 'dhcp',             label: 'DHCP',                 section: 'DNS & Network' },
  { key: 'network',          label: 'Network Infra',       section: 'DNS & Network' },
  { key: 'phones',           label: 'Phone System',        section: 'DNS & Network' },
  { key: 'roster',           label: 'Roster Sync',         section: 'System' },
  { key: 'bell_schedule',    label: 'Bell Schedule',       section: 'System' },
  { key: 'integrations',     label: 'Integrations',        section: 'System' },
  { key: 'ha_monitoring',    label: 'HA Cluster (view)',   section: 'System' },
  { key: 'vpn_config',       label: 'VPN (view)',          section: 'System' },
  { key: 'ipv6_config',      label: 'IPv6 (view)',         section: 'System' },
  { key: 'ntp_monitoring',   label: 'NTP (view)',          section: 'System' },
  { key: 'system_health',    label: 'System Health',       section: 'System' },
  { key: 'security_scan',    label: 'Security Scan',       section: 'System', sensitive: true },
  { key: 'reports',          label: 'Reports',             section: 'System', sensitive: true },
  { key: 'lost_mode',        label: 'Chromebook Lost Mode', section: 'System', sensitive: true },
  { key: 'knowledge_base',   label: 'Knowledge Base (edit)', section: 'System' },
  { key: 'internet_monitoring', label: 'Internet Health (view)', section: 'System' },
  { key: 'settings',         label: 'Settings',            section: 'System', sensitive: true },
  // Export only -- restore is hardcoded superadmin-only at the route
  // level (backend/src/routes/backup.js), same tier as VPN CA/HA promote/
  // TLS issuance, since a bad restore can overwrite the whole district's
  // configuration in one request.
  { key: 'backup_export',   label: 'Backup Export',       section: 'System', sensitive: true },
  { key: 'classpulse',      label: 'ClassPulse (admin config)', section: 'ClassPulse' },
];

const PERMISSION_KEYS = new Set(PERMISSION_CATALOG.map(p => p.key));

function permissionsKey(userId) {
  return `user:permissions:${userId}`;
}

// Returns UNRESTRICTED ('*') for a user with no custom_role_id (today's
// default, full admin access), or a Set of granted permission_key strings
// for a user restricted to a specific custom role.
async function getEffectivePermissions(userId) {
  const cached = await redis.get(permissionsKey(userId)).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      return parsed === UNRESTRICTED ? UNRESTRICTED : new Set(parsed);
    } catch {}
  }

  const { rows: userRows } = await query('SELECT custom_role_id FROM users WHERE id = $1', [userId]);
  const roleId = userRows[0]?.custom_role_id || null;

  let result;
  if (!roleId) {
    result = UNRESTRICTED;
  } else {
    const { rows } = await query(
      'SELECT permission_key FROM custom_role_permissions WHERE role_id = $1',
      [roleId]
    );
    result = rows.map(r => r.permission_key);
  }

  await redis.set(
    permissionsKey(userId),
    JSON.stringify(result === UNRESTRICTED ? UNRESTRICTED : result),
    'EX', PERMISSIONS_TTL
  );
  return result === UNRESTRICTED ? UNRESTRICTED : new Set(result);
}

// superadmin is always fully unrestricted — this system only ever narrows
// access within the 'admin' tier, never elevates or limits superadmin.
async function hasPermission(userId, role, key) {
  if (role === 'superadmin') return true;
  const effective = await getEffectivePermissions(userId);
  return effective === UNRESTRICTED || effective.has(key);
}

async function invalidatePermissions(userId) {
  await redis.del(permissionsKey(userId));
}

// Called whenever a custom role's own permission set changes — every user
// currently assigned that role needs their cache busted, mirrors
// policyResolver.js's invalidatePoliciesForClass bulk-pipeline pattern.
async function invalidatePermissionsForRole(roleId) {
  const { rows } = await query('SELECT id FROM users WHERE custom_role_id = $1', [roleId]);
  if (rows.length === 0) return;
  const pipeline = redis.pipeline();
  for (const { id } of rows) pipeline.del(permissionsKey(id));
  await pipeline.exec();
}

module.exports = {
  PERMISSION_CATALOG, PERMISSION_KEYS, UNRESTRICTED,
  getEffectivePermissions, hasPermission,
  invalidatePermissions, invalidatePermissionsForRole,
};
