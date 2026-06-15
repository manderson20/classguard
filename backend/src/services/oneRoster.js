/**
 * OneRoster 1.1 roster sync — compatible with Infinite Campus, PowerSchool,
 * Skyward, Aeries, and any other IMS-certified SIS.
 *
 * Auth: OAuth2 client credentials (the most common SIS implementation).
 * Infinite Campus: Settings → System Administration → Data Integrations → Campus API
 *   → OneRoster tab → create an API key pair (client_id + client_secret).
 *
 * Sync order: orgs → users → courses → classes → enrollments
 *
 * Matching strategy (avoids duplicating users):
 *   1. Match by oneroster_sourced_id (same source, same record)
 *   2. Match by email
 *   3. Create new user
 */

const { pool } = require('../db');

// ---------------------------------------------------------------------------
// OAuth2 client credentials token fetch
// ---------------------------------------------------------------------------

const tokenCache = new Map(); // sourceId → { token, expiresAt }

async function getToken(source) {
  const cached = tokenCache.get(source.id);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     source.client_id,
    client_secret: source.client_secret,
  });

  const https  = require('https');
  const agent  = new https.Agent({ rejectUnauthorized: false }); // IC sometimes uses self-signed
  const axios  = require('axios');

  // Infinite Campus token URL is typically /api/oneroster/v1p1/token or /as/token
  const tokenUrl = source.base_url.replace(/\/ims\/oneroster.*$/, '') + '/as/token.oauth2';

  const res = await axios.post(tokenUrl, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    httpsAgent: agent,
    timeout: 15_000,
  });

  const token      = res.data.access_token;
  const expiresIn  = res.data.expires_in || 3600;
  tokenCache.set(source.id, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

// ---------------------------------------------------------------------------
// Paginated OneRoster GET with Link header support
// ---------------------------------------------------------------------------

async function orGet(source, path, params = {}) {
  const axios  = require('axios');
  const https  = require('https');
  const agent  = new https.Agent({ rejectUnauthorized: false });
  const token  = await getToken(source);
  const base   = source.base_url.replace(/\/$/, '');
  const results = [];

  let url    = `${base}${path}`;
  let offset = 0;
  const limit = 1000;

  while (true) {
    const res = await axios.get(url, {
      headers:    { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      params:     { ...params, limit, offset },
      httpsAgent: agent,
      timeout:    30_000,
    });

    // OneRoster wraps results in an object keyed by the resource name
    const data = res.data;
    // Try to find the array in the response (key varies: "users", "classes", etc.)
    const key  = Object.keys(data).find(k => Array.isArray(data[k]));
    if (!key) break;

    const items = data[key];
    results.push(...items);

    if (items.length < limit) break;
    offset += limit;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Map OneRoster role to ClassGuard role
// ---------------------------------------------------------------------------
function mapRole(orRole) {
  const r = (orRole || '').toLowerCase();
  if (r === 'teacher' || r === 'aide') return 'teacher';
  if (r === 'administrator' || r === 'proctor') return 'admin';
  return 'student';
}

// ---------------------------------------------------------------------------
// Upsert a user from OneRoster data
// ---------------------------------------------------------------------------
async function upsertUser(orUser, sourceId) {
  const email      = (orUser.email || orUser.username || '').toLowerCase();
  const sourcedId  = orUser.sourcedId;
  const role       = mapRole(orUser.role);
  const fullName   = [orUser.givenName, orUser.familyName].filter(Boolean).join(' ');
  const givenName  = orUser.givenName || null;
  const studentNum = orUser.identifier || orUser.localId || null;
  const grade      = orUser.grades?.[0] || null;

  if (!email && !sourcedId) return null;

  const { rows } = await pool.query(
    `INSERT INTO users
       (google_id, email, full_name, given_name, role,
        oneroster_sourced_id, oneroster_username, student_number, grade_level,
        sync_source, is_active, last_synced_at)
     VALUES
       (NULL, $1, $2, $3, $4, $5, $6, $7, $8, 'oneroster', true, NOW())
     ON CONFLICT (email) DO UPDATE SET
       full_name            = COALESCE(EXCLUDED.full_name, users.full_name),
       given_name           = COALESCE(EXCLUDED.given_name, users.given_name),
       oneroster_sourced_id = COALESCE(EXCLUDED.oneroster_sourced_id, users.oneroster_sourced_id),
       student_number       = COALESCE(EXCLUDED.student_number, users.student_number),
       grade_level          = COALESCE(EXCLUDED.grade_level, users.grade_level),
       is_active            = true,
       last_synced_at       = NOW()
     RETURNING id`,
    [email || null, fullName || null, givenName, role,
     sourcedId, orUser.username || null, studentNum, grade]
  ).catch(async () => {
    // If email conflict on google_id UNIQUE (rare), fall back to sourcedId match
    if (sourcedId) {
      return pool.query(
        `SELECT id FROM users WHERE oneroster_sourced_id = $1`, [sourcedId]
      );
    }
    return { rows: [] };
  });

  return rows[0]?.id || null;
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------
async function syncOneRoster(sourceId, onProgress = () => {}) {
  const { rows } = await pool.query('SELECT * FROM oneroster_sources WHERE id = $1', [sourceId]);
  if (!rows.length) throw new Error('OneRoster source not found');
  const source = rows[0];

  onProgress(`Starting OneRoster sync from ${source.name}…`);

  // 1. Fetch all users (staff + students)
  onProgress('Fetching users…');
  const orUsers = await orGet(source, '/users', {
    filter: source.school_year ? `status='active'` : undefined,
  });
  onProgress(`Found ${orUsers.length} users`);

  const userMap = new Map(); // sourcedId → ClassGuard user id
  let usersUpserted = 0;
  for (const u of orUsers) {
    const uid = await upsertUser(u, sourceId);
    if (uid) { userMap.set(u.sourcedId, uid); usersUpserted++; }
  }
  onProgress(`Upserted ${usersUpserted} users`);

  // 2. Fetch all classes (sections in IC terminology)
  onProgress('Fetching classes/sections…');
  const orClasses = await orGet(source, '/classes');
  onProgress(`Found ${orClasses.length} classes`);

  const classMap   = new Map(); // sourcedId → ClassGuard class id
  let classesSynced = 0;

  for (const oc of orClasses) {
    // Skip inactive
    if (oc.status && oc.status !== 'active') continue;

    // Build a meaningful name: course title + section
    const name = [oc.title, oc.classCode].filter(Boolean).join(' — ');

    const { rows: cr } = await pool.query(
      `INSERT INTO classes
         (name, oneroster_sourced_id, course_code, period, school_year, sync_source, is_active)
       VALUES ($1, $2, $3, $4, $5, 'oneroster', true)
       ON CONFLICT (oneroster_sourced_id) DO UPDATE SET
         name = EXCLUDED.name,
         course_code = EXCLUDED.course_code,
         period = EXCLUDED.period,
         is_active = true
       RETURNING id`,
      [name, oc.sourcedId, oc.classCode || null,
       oc.periods?.[0]?.period || null, source.school_year || null]
    );
    const classId = cr[0]?.id;
    if (!classId) continue;
    classMap.set(oc.sourcedId, classId);
    classesSynced++;
  }
  onProgress(`Upserted ${classesSynced} classes`);

  // 3. Fetch enrollments (the roster linkage: user → class + role)
  onProgress('Fetching enrollments…');
  const enrollments = await orGet(source, '/enrollments', {
    filter: source.school_year ? `status='active'` : undefined,
  });
  onProgress(`Found ${enrollments.length} enrollments`);

  let enrollCount = 0;
  for (const e of enrollments) {
    if (e.status && e.status !== 'active') continue;

    const classId  = classMap.get(e.class?.sourcedId);
    const userId   = userMap.get(e.user?.sourcedId);
    const role     = mapRole(e.role);

    if (!classId || !userId) continue;

    if (role === 'teacher') {
      // Set teacher_id on the class (first teacher wins)
      await pool.query(
        'UPDATE classes SET teacher_id = $1 WHERE id = $2 AND teacher_id IS NULL',
        [userId, classId]
      );
    } else {
      // Enroll student
      await pool.query(
        `INSERT INTO class_members (class_id, student_id, sync_source)
         VALUES ($1, $2, 'oneroster')
         ON CONFLICT (class_id, student_id) DO UPDATE SET sync_source = 'oneroster'`,
        [classId, userId]
      );
      enrollCount++;
    }
  }
  onProgress(`Enrolled ${enrollCount} students`);

  // 4. Deactivate classes from this source that no longer appear in the SIS
  const activeSourcIds = orClasses
    .filter(c => !c.status || c.status === 'active')
    .map(c => c.sourcedId);

  if (activeSourcIds.length > 0) {
    await pool.query(
      `UPDATE classes SET is_active = false
       WHERE sync_source = 'oneroster'
         AND oneroster_sourced_id IS NOT NULL
         AND oneroster_sourced_id <> ALL($1::text[])`,
      [activeSourcIds]
    );
  }

  // 5. Update sync status
  await pool.query(
    'UPDATE oneroster_sources SET last_sync = NOW(), last_error = NULL WHERE id = $1',
    [sourceId]
  );

  const summary = { usersUpserted, classesSynced, enrollCount };
  onProgress(`OneRoster sync complete: ${JSON.stringify(summary)}`);
  return summary;
}

// ---------------------------------------------------------------------------
// Test connection — just fetches /orgs (cheap and always available)
// ---------------------------------------------------------------------------
async function testConnection(source) {
  const orgs = await orGet(source, '/orgs');
  return { ok: true, orgs: orgs.slice(0, 5).map(o => ({ name: o.name, type: o.type })) };
}

module.exports = { syncOneRoster, testConnection };
