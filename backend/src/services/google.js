/**
 * Google Workspace Sync Service
 *
 * Prerequisites — Domain-Wide Delegation setup:
 *   1. In Google Cloud Console, create a Service Account and download the JSON key.
 *      Paste its full contents into Integrations > Google Workspace > Device & Directory
 *      Sync in the admin UI (stored in Postgres — replicated across HA nodes, unlike a
 *      key file on one node's disk).
 *   2. In Google Workspace Admin Console → Security → API Controls →
 *      Domain-wide Delegation, add the service account's numeric Client ID (not its
 *      email) with these scopes:
 *        https://www.googleapis.com/auth/admin.directory.user.readonly
 *        https://www.googleapis.com/auth/admin.directory.group.readonly
 *        https://www.googleapis.com/auth/admin.directory.orgunit.readonly
 *        https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly
 *        https://www.googleapis.com/auth/admin.directory.device.chromeos   (write -- only
 *          needed for Lost Mode's disable/reenable action below; omit this scope if you
 *          don't want ClassGuard able to remotely disable a Chromebook at all)
 *   3. Set the Superadmin Email (same admin UI section) to a Google Workspace
 *      super-admin address; the service account impersonates them to call the Admin SDK.
 *
 * This is a distinct credential from both the "Google Workspace Login" OAuth client
 * (Web application type, used for admin/teacher SSO) and the Chrome Extension's OAuth
 * client (chrome.identity) — none of the three are interchangeable.
 */

const { google }  = require('googleapis');
const { pool }    = require('../db');

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value || null;
}

// Shared by initGoogleAdmin() below and routes/integrations.js's Chromebook sync —
// same service account, different scopes per call.
async function getServiceAccountAuth(scopes) {
  const serviceAccountJson = await getSetting('google_service_account_json');
  const superadmin         = await getSetting('google_superadmin_email') || process.env.SUPERADMIN_EMAIL;

  if (!superadmin) {
    throw new Error('Superadmin email not configured — set it under Integrations > Google Workspace > Device & Directory Sync');
  }

  if (serviceAccountJson) {
    let credentials;
    try {
      credentials = JSON.parse(serviceAccountJson);
    } catch {
      throw new Error('Stored Google service account JSON is not valid JSON — re-paste it under Integrations > Google Workspace');
    }
    return new google.auth.GoogleAuth({ credentials, scopes, clientOptions: { subject: superadmin } });
  }

  // Fall back to a key file on disk, for installs set up before this moved to the DB.
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) {
    throw new Error('Service account not configured — paste the service account JSON under Integrations > Google Workspace > Device & Directory Sync');
  }
  return new google.auth.GoogleAuth({ keyFile: keyPath, scopes, clientOptions: { subject: superadmin } });
}

// ---------------------------------------------------------------------------
// OU → role mapping
// ---------------------------------------------------------------------------
// Configurable rather than hardcoded to this district's "/Students" vs
// "/Employees" convention — other schools' Workspace OU trees use different
// top-level names. Stored as Integrations > Google Workspace > Device &
// Directory Sync > "Role Mapping by OU". Longest matching prefix wins so a
// more specific rule (e.g. "/Employees/Substitute Teachers" -> student-ish
// restricted access) can override a broader one ("/Employees" -> teacher).
const DEFAULT_OU_ROLE_RULES = [
  { ouPrefix: '/Students',  role: 'student' },
  { ouPrefix: '/Employees', role: 'teacher' },
];

function ouMatchesPrefix(ouPath, prefix) {
  return ouPath === prefix || ouPath.startsWith(prefix.replace(/\/$/, '') + '/');
}

async function getOuRoleRules() {
  const raw = await getSetting('google_ou_role_rules');
  if (!raw) return DEFAULT_OU_ROLE_RULES;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_OU_ROLE_RULES;
  } catch {
    return DEFAULT_OU_ROLE_RULES;
  }
}

function resolveRoleFromOu(ouPath, rules) {
  if (!ouPath) return 'student';
  const matches = rules.filter(r => ouMatchesPrefix(ouPath, r.ouPrefix));
  if (!matches.length) return 'student';
  matches.sort((a, b) => b.ouPrefix.length - a.ouPrefix.length);
  return matches[0].role;
}

// Re-applies the current OU role rules to every user whose role has never
// been manually overridden — used both right after the next scheduled sync
// and on-demand from the UI when an admin edits the rules (so a rule change
// doesn't require waiting for the next sync to take effect).
async function backfillRolesFromOu(actorId = null) {
  const rules = await getOuRoleRules();
  const { rows } = await pool.query(
    `SELECT id, google_ou, role FROM users WHERE role_source = 'auto' AND google_ou IS NOT NULL AND google_ou <> ''`
  );

  let changed = 0;
  for (const u of rows) {
    const newRole = resolveRoleFromOu(u.google_ou, rules);
    if (newRole !== u.role) {
      await pool.query(`UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`, [newRole, u.id]);
      changed++;
    }
  }

  await _auditLog(actorId, 'google_backfill_roles', { checked: rows.length, changed });
  return { checked: rows.length, changed };
}

const ADMIN_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
];

// ---------------------------------------------------------------------------
// Exponential backoff for rate-limited Google API calls
// ---------------------------------------------------------------------------
async function withBackoff(fn, maxAttempts = 5) {
  let delay = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.code === 429 ||
        (err.response && (err.response.status === 429 || err.response.status === 403));

      if (!isRateLimit || attempt === maxAttempts) throw err;

      await new Promise(r => setTimeout(r, delay + Math.random() * 500));
      delay = Math.min(delay * 2, 32_000);
    }
  }
}

// ---------------------------------------------------------------------------
// Build an authenticated Admin SDK client
// ---------------------------------------------------------------------------
async function initGoogleAdmin() {
  const auth = await getServiceAccountAuth(ADMIN_SCOPES);
  return google.admin({ version: 'directory_v1', auth });
}

// ---------------------------------------------------------------------------
// Paginate through all pages of a Google Admin API list call
// ---------------------------------------------------------------------------
async function paginate(fn, params = {}) {
  const results = [];
  let pageToken;

  do {
    const response = await withBackoff(() =>
      fn({ ...params, ...(pageToken ? { pageToken } : {}) })
    );
    const { data } = response;
    pageToken = data.nextPageToken;

    // Each list method returns the payload under a different key
    const items = data.users || data.groups || data.members || data.organizationUnits || [];
    results.push(...items);
  } while (pageToken);

  return results;
}

// ---------------------------------------------------------------------------
// syncUsers
// ---------------------------------------------------------------------------
async function syncUsers(admin, actorId) {
  // customer (whole Workspace account), not domain — a single domain misses
  // every user on a secondary domain or subdomain (e.g. students issued
  // accounts under students.example.org while staff are on example.org).
  // syncOrgUnits already used customer, which is why the OU tree pulled in
  // all 136 OUs while this only ever synced one domain's worth of users.
  const customerId = await getSetting('google_customer_id') || process.env.GOOGLE_CUSTOMER_ID || 'my_customer';

  const googleUsers = await paginate(
    (p) => admin.users.list(p),
    { customer: customerId, maxResults: 500, orderBy: 'email' }
  );

  const rules     = await getOuRoleRules();
  const googleIds = new Set();

  for (const gu of googleUsers) {
    googleIds.add(gu.id);
    const role = resolveRoleFromOu(gu.orgUnitPath, rules);

    // Conflict target is email, not google_id: google_id is nullable (e.g. a
    // user created earlier via OneRoster import has it NULL), and Postgres
    // treats every NULL as distinct for a unique constraint, so ON CONFLICT
    // (google_id) silently never matches those rows — it tried a fresh
    // INSERT instead and hit the separate email-uniqueness violation.
    // email is NOT NULL + UNIQUE for every row, so it's the reliable match.
    //
    // role/role_source: only set on first INSERT. On conflict, role is left
    // alone entirely whenever role_source = 'manual' (an admin explicitly
    // set it via PUT /users/:id/role) — otherwise it's re-derived from the
    // OU rules every sync, so a student moved to a staff OU picks up the
    // right role on the next run without anyone having to fix it by hand.
    await pool.query(
      `INSERT INTO users
         (google_id, email, full_name, given_name, photo_url, google_ou, role, role_source, last_synced_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'auto',NOW(),NOW())
       ON CONFLICT (email) DO UPDATE SET
         google_id      = EXCLUDED.google_id,
         full_name      = EXCLUDED.full_name,
         given_name     = EXCLUDED.given_name,
         photo_url      = EXCLUDED.photo_url,
         google_ou      = EXCLUDED.google_ou,
         role           = CASE WHEN users.role_source = 'manual' THEN users.role ELSE EXCLUDED.role END,
         is_active      = true,
         last_synced_at = NOW(),
         updated_at     = NOW()`,
      [
        gu.id,
        gu.primaryEmail,
        gu.name?.fullName    ?? null,
        gu.name?.givenName   ?? null,
        gu.thumbnailPhotoUrl ?? null,
        gu.orgUnitPath       ?? null,
        role,
      ]
    );
  }

  // Deactivate users no longer in Google
  if (googleIds.size > 0) {
    const idList = [...googleIds];
    await pool.query(
      `UPDATE users SET is_active = false, updated_at = NOW()
       WHERE google_id != ALL($1::text[]) AND is_active = true`,
      [idList]
    );
  }

  await _auditLog(actorId, 'google_sync_users', { count: googleUsers.length });
  return googleUsers.length;
}

// ---------------------------------------------------------------------------
// syncGroups
// ---------------------------------------------------------------------------
async function syncGroups(admin, actorId) {
  const customerId = await getSetting('google_customer_id') || process.env.GOOGLE_CUSTOMER_ID || 'my_customer';

  const googleGroups = await paginate(
    (p) => admin.groups.list(p),
    { customer: customerId, maxResults: 200 }
  );

  for (const gg of googleGroups) {
    // Upsert group row
    const { rows } = await pool.query(
      `INSERT INTO groups (name, description, google_group_email)
       VALUES ($1, $2, $3)
       ON CONFLICT (google_group_email) WHERE google_group_email IS NOT NULL DO UPDATE SET
         name        = EXCLUDED.name,
         description = EXCLUDED.description
       RETURNING id`,
      [gg.name, gg.description ?? null, gg.email]
    );
    const groupId = rows[0].id;

    // Fetch members with pagination
    const members = await paginate(
      (p) => admin.members.list(p),
      { groupKey: gg.email, maxResults: 200 }
    ).catch(() => []); // group may have no members or access denied

    for (const m of members) {
      // Only sync members that exist in our users table
      const userRow = await pool.query(
        'SELECT id FROM users WHERE email = $1', [m.email]
      );
      if (!userRow.rows.length) continue;

      await pool.query(
        `INSERT INTO group_members (group_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, userRow.rows[0].id]
      );
    }
  }

  await _auditLog(actorId, 'google_sync_groups', { count: googleGroups.length });
  return googleGroups.length;
}

// ---------------------------------------------------------------------------
// syncOrgUnits
// ---------------------------------------------------------------------------
async function syncOrgUnits(admin, actorId) {
  const customerId = await getSetting('google_customer_id') || process.env.GOOGLE_CUSTOMER_ID || 'my_customer';

  const response = await withBackoff(() =>
    admin.orgunits.list({ customerId, type: 'all' })
  );

  const ous = response.data.organizationUnits ?? [];

  // Build a simple tree-friendly array and persist as JSON in settings
  const tree = ous.map(ou => ({
    name:        ou.name,
    path:        ou.orgUnitPath,
    parentPath:  ou.parentOrgUnitPath,
    description: ou.description ?? null,
  }));

  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('google_ous', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(tree)]
  );

  await _auditLog(actorId, 'google_sync_ous', { count: ous.length });
  return ous.length;
}

// ---------------------------------------------------------------------------
// syncAll — orchestrates the full sync and updates last_google_sync
// ---------------------------------------------------------------------------
async function syncAll(actorId = null) {
  const admin = await initGoogleAdmin();

  const [userCount, groupCount, ouCount] = await Promise.all([
    syncUsers(admin, actorId),
    syncGroups(admin, actorId),
    syncOrgUnits(admin, actorId),
  ]);

  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('last_google_sync', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [new Date().toISOString()]
  );

  await _auditLog(actorId, 'google_sync_complete', { userCount, groupCount, ouCount });

  return { userCount, groupCount, ouCount };
}

// ---------------------------------------------------------------------------
// Chromebook device inventory sync — separate from syncAll() (users/groups/
// OUs) above on purpose: one can fail while the other succeeds (e.g. a
// directory-sync bug shouldn't mask that devices already synced fine), and
// radiusSync.js also calls this directly to refresh integration_devices
// before pulling MACs into the RADIUS device list, so it needs to be a
// standalone export rather than inlined in the route handler.
// ---------------------------------------------------------------------------

// Some Chrome device fields (e.g. tpmVersionInfo.vendorSpecific) come back
// from the Admin SDK as raw binary leaked through as a JS "string", with
// embedded NUL/control bytes — Postgres's jsonb input flatly rejects
// ("unsupported Unicode escape sequence"), which aborted this whole sync
// partway through every time it reached the first such device.
function stripControlChars(value) {
  if (typeof value === 'string') return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  if (Array.isArray(value)) return value.map(stripControlChars);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripControlChars(v)]));
  }
  return value;
}

async function syncDevices(actorId) {
  const auth  = await getServiceAccountAuth(['https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly']);
  const admin = google.admin({ version: 'directory_v1', auth });

  const { rows: [customerSetting] } = await pool.query(
    `SELECT value FROM settings WHERE key = 'google_customer_id'`
  );
  const devices = [];
  let pageToken;

  do {
    const res = await admin.chromeosdevices.list({
      customerId:  customerSetting?.value || process.env.GOOGLE_CUSTOMER_ID || 'my_customer',
      maxResults:  200,
      ...(pageToken ? { pageToken } : {}),
    });
    devices.push(...(res.data.chromeosdevices || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  for (const d of devices) {
    // lastKnownNetwork holds the device's most recent LAN (ipAddress) and
    // WAN/public (wanIpAddress) addresses — a Chromebook taken home reports
    // its home router's public IP here, not anything on our network. Both
    // get stored; services/integrationDeviceIpamSync.js decides which (if
    // any) actually fall inside a documented IPAM subnet before registering
    // anything — see the "offsite devices" discussion this came from.
    const net = (d.lastKnownNetwork || [])[0] || {};
    const ips = [...new Set([net.ipAddress, net.wanIpAddress].filter(Boolean))];

    // autoUpdateExpiration is a Unix timestamp in milliseconds (string from API)
    const aupMs  = d.autoUpdateExpiration ? parseInt(d.autoUpdateExpiration, 10) : null;
    const aupDate = aupMs && aupMs > 0 ? new Date(aupMs).toISOString().split('T')[0] : null;

    await pool.query(
      `INSERT INTO integration_devices
         (source, external_id, serial_number, mac_addresses, device_name, device_model,
          os_type, os_version, assigned_email, ip_addresses, status, last_seen,
          aup_date, aup_source, raw_data, synced_at)
       VALUES ('google_admin',$1,$2,$3,$4,$5,'ChromeOS',$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (source, external_id) DO UPDATE SET
         serial_number = EXCLUDED.serial_number, mac_addresses = EXCLUDED.mac_addresses,
         device_name = EXCLUDED.device_name, os_version = EXCLUDED.os_version,
         assigned_email = EXCLUDED.assigned_email, ip_addresses = EXCLUDED.ip_addresses,
         status = EXCLUDED.status,
         last_seen = EXCLUDED.last_seen,
         aup_date   = EXCLUDED.aup_date,
         aup_source = EXCLUDED.aup_source,
         raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
      [d.deviceId, d.serialNumber,
       `{${[d.macAddress, d.ethernetMacAddress].filter(Boolean).join(',')}}`,
       d.annotatedAssetId || d.deviceId, d.model,
       d.osVersion, d.lastEnrollmentTime ? d.annotatedUser || null : null,
       `{${ips.join(',')}}`,
       d.status, d.lastSync ? new Date(d.lastSync) : null,
       aupDate, aupDate ? 'google_admin' : null,
       JSON.stringify(stripControlChars(d))]
    );
  }

  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('last_google_devices_sync', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [new Date().toISOString()]
  );

  return devices.length;
}

// ---------------------------------------------------------------------------
// Lost Mode -- disable/reenable a Chromebook via the Directory API's device
// action endpoint. Google has no API field for a per-incident custom lock
// message: the disable screen always shows whatever's configured once,
// domain- or OU-wide, in Admin Console > Devices > Chrome > Settings >
// Device > "Device disabling" -- there's nothing to template here on
// ClassGuard's side beyond pointing an admin at that one-time setup.
// Needs the WRITE scope (admin.directory.device.chromeos, not .readonly) on
// the domain-wide delegation grant -- a missing-scope error surfaces here as
// a 403 from Google, which callers should show verbatim rather than retry.
// ---------------------------------------------------------------------------
async function setChromeDeviceAction(deviceId, action, actorId) {
  if (!['disable', 'reenable'].includes(action)) throw new Error(`Unsupported action: ${action}`);

  const auth  = await getServiceAccountAuth(['https://www.googleapis.com/auth/admin.directory.device.chromeos']);
  const admin = google.admin({ version: 'directory_v1', auth });

  const { rows: [customerSetting] } = await pool.query(
    `SELECT value FROM settings WHERE key = 'google_customer_id'`
  );

  try {
    await admin.chromeosdevices.action({
      customerId: customerSetting?.value || process.env.GOOGLE_CUSTOMER_ID || 'my_customer',
      deviceId,
      requestBody: { action },
    });
    await _auditLog(actorId, `lost_mode_${action}`, { deviceId, result: 'success' });
  } catch (err) {
    await _auditLog(actorId, `lost_mode_${action}`, { deviceId, result: 'error', error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal audit log helper
// ---------------------------------------------------------------------------
async function _auditLog(actorId, action, details) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target_type, details)
       VALUES ($1, $2, 'google_sync', $3)`,
      [actorId, action, JSON.stringify(details)]
    );
  } catch {
    // Non-fatal — don't let audit failures abort sync
  }
}

// ---------------------------------------------------------------------------
// Write an asset tag back to a Chromebook's annotatedAssetId field in Google
// Admin. Requires the write scope (admin.directory.device.chromeos) —
// same as Lost Mode actions.
// ---------------------------------------------------------------------------
async function updateChromebookAssetId(deviceId, assetTag) {
  const auth  = await getServiceAccountAuth(['https://www.googleapis.com/auth/admin.directory.device.chromeos']);
  const admin = google.admin({ version: 'directory_v1', auth });
  const { rows: [cs] } = await pool.query(`SELECT value FROM settings WHERE key = 'google_customer_id'`);
  await admin.chromeosdevices.patch({
    customerId:  cs?.value || process.env.GOOGLE_CUSTOMER_ID || 'my_customer',
    deviceId,
    requestBody: { annotatedAssetId: assetTag },
  });
}

module.exports = {
  initGoogleAdmin, syncAll, syncUsers, syncGroups, syncOrgUnits, getServiceAccountAuth,
  getOuRoleRules, resolveRoleFromOu, backfillRolesFromOu, syncDevices, setChromeDeviceAction,
  updateChromebookAssetId,
};
