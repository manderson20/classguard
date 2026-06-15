/**
 * Google Classroom roster sync.
 *
 * What it syncs:
 *   1. All active Classroom courses → ClassGuard classes (creates or updates)
 *   2. Course teachers → ClassGuard users (role=teacher)
 *   3. Course students → ClassGuard users (role=student), enrolled in the class
 *
 * Requirements:
 *   - Google service account with domain-wide delegation
 *   - Scopes: classroom.courses.readonly, classroom.rosters.readonly,
 *             classroom.profile.emails, admin.directory.user.readonly
 *   - SUPERADMIN_EMAIL env var (the account the service account impersonates)
 *
 * Matching strategy:
 *   - Users matched by email first, then google_id.
 *   - New users are upserted with google_id from Classroom profile data.
 *   - Existing manually-created users are linked via email match.
 */

const { pool } = require('../db');

async function getAuth() {
  const keyPath    = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const superadmin = process.env.SUPERADMIN_EMAIL;
  if (!keyPath || !superadmin) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_PATH and SUPERADMIN_EMAIL required');

  const { google } = require('googleapis');
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: [
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.rosters.readonly',
      'https://www.googleapis.com/auth/classroom.profile.emails',
      'https://www.googleapis.com/auth/admin.directory.user.readonly',
    ],
    clientOptions: { subject: superadmin },
  });
}

// ---------------------------------------------------------------------------
// Upsert a user from Classroom profile data, return ClassGuard user id
// ---------------------------------------------------------------------------
async function upsertUser(profile, role) {
  const email    = profile.emailAddress?.toLowerCase();
  const googleId = profile.id;
  const name     = profile.name?.fullName || email;
  const given    = profile.name?.givenName || null;
  const photo    = profile.photoUrl || null;

  if (!email) return null;

  const { rows } = await pool.query(
    `INSERT INTO users (google_id, email, full_name, given_name, photo_url, role, sync_source, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'google', NOW())
     ON CONFLICT (email) DO UPDATE SET
       google_id      = COALESCE(EXCLUDED.google_id, users.google_id),
       full_name      = COALESCE(EXCLUDED.full_name, users.full_name),
       given_name     = COALESCE(EXCLUDED.given_name, users.given_name),
       photo_url      = COALESCE(EXCLUDED.photo_url, users.photo_url),
       sync_source    = CASE WHEN users.sync_source = 'manual' THEN 'google' ELSE users.sync_source END,
       last_synced_at = NOW()
     RETURNING id`,
    [googleId, email, name, given, photo, role]
  );
  return rows[0]?.id || null;
}

// ---------------------------------------------------------------------------
// Paginate a Classroom API list call
// ---------------------------------------------------------------------------
async function pageAll(fn, key) {
  const items    = [];
  let   pageToken;
  do {
    const res = await fn(pageToken);
    items.push(...(res.data[key] || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------
async function syncClassroom(actorId, onProgress = () => {}) {
  const { google } = require('googleapis');
  const auth       = await getAuth();
  const classroom  = google.classroom({ version: 'v1', auth });

  onProgress('Fetching Classroom courses…');
  const courses = await pageAll(
    pt => classroom.courses.list({ courseStates: ['ACTIVE'], pageSize: 100, pageToken: pt }),
    'courses'
  );
  onProgress(`Found ${courses.length} active courses`);

  let classesSynced  = 0;
  let studentsSynced = 0;
  let teachersSynced = 0;

  for (const course of courses) {
    const courseId   = course.id;
    const courseName = course.name;
    const section    = course.section || null;

    // Upsert the ClassGuard class record
    const { rows: classRows } = await pool.query(
      `INSERT INTO classes (name, google_classroom_id, period, sync_source, is_active)
       VALUES ($1, $2, $3, 'google_classroom', true)
       ON CONFLICT (google_classroom_id) DO UPDATE SET
         name = EXCLUDED.name,
         period = EXCLUDED.period,
         is_active = true
       RETURNING id`,
      [courseName, courseId, section]
    );
    const classId = classRows[0]?.id;
    if (!classId) continue;

    // Track in classroom_course_map
    await pool.query(
      `INSERT INTO classroom_course_map (classroom_course_id, class_id, course_name, last_sync)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (classroom_course_id) DO UPDATE SET
         class_id = EXCLUDED.class_id, course_name = EXCLUDED.course_name, last_sync = NOW()`,
      [courseId, classId, courseName]
    );

    // Sync teachers
    const teachers = await pageAll(
      pt => classroom.courses.teachers.list({ courseId, pageSize: 100, pageToken: pt }),
      'teachers'
    ).catch(() => []);

    for (const t of teachers) {
      const uid = await upsertUser(t.profile, 'teacher');
      if (uid) {
        // Set as class teacher (first teacher wins if multiple)
        await pool.query(
          `UPDATE classes SET teacher_id = $1 WHERE id = $2 AND teacher_id IS NULL`,
          [uid, classId]
        );
        teachersSynced++;
      }
    }

    // Sync students
    const students = await pageAll(
      pt => classroom.courses.students.list({ courseId, pageSize: 100, pageToken: pt }),
      'students'
    ).catch(() => []);

    for (const s of students) {
      const uid = await upsertUser(s.profile, 'student');
      if (uid) {
        await pool.query(
          `INSERT INTO class_members (class_id, student_id, sync_source)
           VALUES ($1, $2, 'google_classroom')
           ON CONFLICT (class_id, student_id) DO UPDATE SET sync_source = 'google_classroom'`,
          [classId, uid]
        );
        studentsSynced++;
      }
    }

    classesSynced++;
    onProgress(`Synced class: ${courseName} (${students.length} students)`);
  }

  // Save last sync timestamp
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('last_classroom_sync', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [new Date().toISOString()]
  );

  const summary = { classesSynced, studentsSynced, teachersSynced };
  onProgress(`Classroom sync complete: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { syncClassroom };
