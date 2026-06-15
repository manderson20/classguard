/**
 * Google Workspace Sync Service
 *
 * Prerequisites — Domain-Wide Delegation setup:
 *   1. In Google Cloud Console, create a Service Account and download the JSON key.
 *      Set GOOGLE_SERVICE_ACCOUNT_KEY_PATH to the absolute path of that file.
 *   2. In Google Workspace Admin Console → Security → API Controls →
 *      Domain-wide Delegation, add the service account's client ID with these scopes:
 *        https://www.googleapis.com/auth/admin.directory.user.readonly
 *        https://www.googleapis.com/auth/admin.directory.group.readonly
 *        https://www.googleapis.com/auth/admin.directory.orgunit.readonly
 *   3. Set SUPERADMIN_EMAIL to a Google Workspace super-admin address; the service
 *      account will impersonate that account to call the Admin SDK.
 *   4. Optional Classroom scopes (add to delegation if used):
 *        https://www.googleapis.com/auth/classroom.courses.readonly
 *        https://www.googleapis.com/auth/classroom.rosters.readonly
 */

const { google }  = require('googleapis');
const { pool }    = require('../db');

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
function initGoogleAdmin() {
  const keyPath     = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const superadmin  = process.env.SUPERADMIN_EMAIL;

  if (!keyPath || !superadmin) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_KEY_PATH and SUPERADMIN_EMAIL must be set for Google Workspace sync — ' +
      'see the domain-wide delegation setup instructions at the top of this file'
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes:  ADMIN_SCOPES,
    clientOptions: { subject: superadmin },
  });

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
  const domain = process.env.GOOGLE_WORKSPACE_DOMAIN;
  if (!domain) throw new Error('GOOGLE_WORKSPACE_DOMAIN env var required for user sync');

  const googleUsers = await paginate(
    (p) => admin.users.list(p),
    { domain, maxResults: 500, orderBy: 'email' }
  );

  const googleIds = new Set();

  for (const gu of googleUsers) {
    googleIds.add(gu.id);

    await pool.query(
      `INSERT INTO users
         (google_id, email, full_name, given_name, photo_url, google_ou, last_synced_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
       ON CONFLICT (google_id) DO UPDATE SET
         email          = EXCLUDED.email,
         full_name      = EXCLUDED.full_name,
         given_name     = EXCLUDED.given_name,
         photo_url      = EXCLUDED.photo_url,
         google_ou      = EXCLUDED.google_ou,
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
  const domain = process.env.GOOGLE_WORKSPACE_DOMAIN;
  if (!domain) throw new Error('GOOGLE_WORKSPACE_DOMAIN env var required for group sync');

  const googleGroups = await paginate(
    (p) => admin.groups.list(p),
    { domain, maxResults: 200 }
  );

  for (const gg of googleGroups) {
    // Upsert group row
    const { rows } = await pool.query(
      `INSERT INTO groups (name, description, google_group_email)
       VALUES ($1, $2, $3)
       ON CONFLICT (google_group_email) DO UPDATE SET
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
  const customerId = process.env.GOOGLE_CUSTOMER_ID || 'my_customer';

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
  const admin = initGoogleAdmin();

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

module.exports = { initGoogleAdmin, syncAll, syncUsers, syncGroups, syncOrgUnits };
