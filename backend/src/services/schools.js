// Schools: which school(s) each user and class belongs to (migration 103).
//
// Memberships come from three sources (user_schools.source):
//   'ou'        — a school's ou_prefixes matched the user's Google OU.
//                 Rebuilt by recompute() whenever schools or OUs change.
//   'oneroster' — the user's OneRoster orgs (services/oneRoster.js).
//   'manual'    — added by an admin; never touched by recompute().
// A class's school is set by OneRoster, by an admin ('manual'), or derived
// here from its teacher's / students' schools ('derived').
const { pool } = require('../db');
const { getOuRoleRules } = require('./google');

// Same prefix rule as services/google.js's ouMatchesPrefix: '/A/B' covers
// '/A/B' itself and anything under '/A/B/', never '/A/Bx'.
function normalizePrefix(p) {
  const s = String(p || '').trim().replace(/\/+$/, '');
  if (!s.startsWith('/') || s.length < 2) return null;
  return s;
}

function normalizePrefixes(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const n = normalizePrefix(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

async function listSchools({ includeInactive = false, withCounts = false } = {}) {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.oneroster_sourced_id, s.ou_prefixes, s.is_active,
            s.created_at, s.updated_at
            ${withCounts ? `,
            (SELECT COUNT(DISTINCT us.user_id) FROM user_schools us JOIN users u ON u.id = us.user_id
              WHERE us.school_id = s.id AND u.role = 'student') AS student_count,
            (SELECT COUNT(DISTINCT us.user_id) FROM user_schools us JOIN users u ON u.id = us.user_id
              WHERE us.school_id = s.id AND u.role <> 'student') AS staff_count,
            (SELECT COUNT(*) FROM classes c WHERE c.school_id = s.id AND c.is_active) AS class_count` : ''}
     FROM schools s
     ${includeInactive ? '' : 'WHERE s.is_active'}
     ORDER BY s.is_active DESC, s.name`
  );
  return rows;
}

// Names that are clearly not schools in a typical OU tree.
const NOT_A_SCHOOL = /withdrawn|graduat|inactive|substitute|nosync|suspended|archive|test/i;

// Suggests schools from the second level of the OU tree under each OU role
// rule prefix (default '/Students' and '/Employees'), e.g.
// '/Students/High School/9th Grade' and '/Employees/High School' both
// suggest "High School". Names that differ only by a trailing
// Center/Campus/Building are grouped. Anything already covered by an
// existing school's prefixes is left out.
async function suggestSchools() {
  const rules = await getOuRoleRules();
  const rolePrefixes = [...new Set(rules.map(r => normalizePrefix(r.ouPrefix)).filter(Boolean))];
  if (!rolePrefixes.length) return [];

  const { rows } = await pool.query(
    `WITH pref AS (SELECT unnest($1::text[]) AS p),
     children AS (
       SELECT pref.p,
              split_part(substr(u.google_ou, length(pref.p) + 2), '/', 1) AS child,
              u.role
       FROM users u
       JOIN pref ON starts_with(u.google_ou, pref.p || '/')
       WHERE u.google_ou IS NOT NULL AND COALESCE(u.is_active, true)
     )
     SELECT p, child, COUNT(*) FILTER (WHERE role = 'student') AS students,
            COUNT(*) FILTER (WHERE role <> 'student') AS staff
     FROM children
     WHERE child <> ''
     GROUP BY p, child`,
    [rolePrefixes]
  );

  const existing = await listSchools();
  const covered = existing.flatMap(s => s.ou_prefixes);
  const isCovered = (prefix) => covered.some(c => prefix === c || prefix.startsWith(c + '/'));

  const groups = new Map();
  for (const r of rows) {
    const prefix = `${r.p}/${r.child}`;
    if (isCovered(prefix)) continue;
    const key = r.child.toLowerCase().replace(/\s+(center|centre|campus|building)$/, '').trim();
    const g = groups.get(key) || { name: r.child, ou_prefixes: [], students: 0, staff: 0, likely_school: false };
    // Prefer the shorter spelling as the display name ("Early Childhood"
    // over "Early Childhood Center").
    if (r.child.length < g.name.length) g.name = r.child;
    g.ou_prefixes.push(prefix);
    g.students += parseInt(r.students, 10);
    g.staff    += parseInt(r.staff, 10);
    groups.set(key, g);
  }

  return [...groups.values()]
    .map(g => ({
      ...g,
      ou_prefixes: g.ou_prefixes.sort(),
      // Both students and staff under the same name is the strongest signal;
      // staff-only names are usually departments (Central Office, Transportation).
      likely_school: g.students > 0 && g.staff > 0 && !NOT_A_SCHOOL.test(g.name),
      probably_not: NOT_A_SCHOOL.test(g.name),
    }))
    .sort((a, b) => (b.likely_school - a.likely_school) || a.name.localeCompare(b.name));
}

// Rebuilds 'ou' memberships from the active schools' prefixes, then
// re-derives class schools. Safe to call any time (idempotent, one
// transaction).
async function recompute() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_schools WHERE source = 'ou'`);
    const { rowCount: ouRows } = await client.query(
      `INSERT INTO user_schools (user_id, school_id, source)
       SELECT DISTINCT u.id, s.id, 'ou'
       FROM users u
       JOIN schools s ON s.is_active
       JOIN LATERAL unnest(s.ou_prefixes) AS p(prefix)
         ON u.google_ou = p.prefix OR starts_with(u.google_ou, p.prefix || '/')
       WHERE u.google_ou IS NOT NULL
       ON CONFLICT DO NOTHING`
    );

    // Class school, unless OneRoster or an admin set it: the teacher's
    // school when they have exactly one; otherwise the school most of the
    // class's students belong to (ties and no data: none).
    const { rowCount: classRows } = await client.query(
      `WITH teacher_school AS (
         SELECT c.id AS class_id, MIN(us.school_id::text)::uuid AS school_id
         FROM classes c
         JOIN user_schools us ON us.user_id = c.teacher_id
         JOIN schools s ON s.id = us.school_id AND s.is_active
         GROUP BY c.id
         HAVING COUNT(DISTINCT us.school_id) = 1
       ),
       student_votes AS (
         SELECT cm.class_id, us.school_id, COUNT(DISTINCT cm.student_id) AS n,
                RANK() OVER (PARTITION BY cm.class_id ORDER BY COUNT(DISTINCT cm.student_id) DESC) AS rnk
         FROM class_members cm
         JOIN user_schools us ON us.user_id = cm.student_id
         JOIN schools s ON s.id = us.school_id AND s.is_active
         GROUP BY cm.class_id, us.school_id
       ),
       student_school AS (
         SELECT class_id, MIN(school_id::text)::uuid AS school_id
         FROM student_votes WHERE rnk = 1
         GROUP BY class_id
         HAVING COUNT(*) = 1
       ),
       derived AS (
         SELECT c.id, COALESCE(ts.school_id, ss.school_id) AS school_id
         FROM classes c
         LEFT JOIN teacher_school ts ON ts.class_id = c.id
         LEFT JOIN student_school ss ON ss.class_id = c.id
         WHERE c.school_source IS NULL OR c.school_source = 'derived'
       )
       UPDATE classes c
          SET school_id = d.school_id,
              school_source = CASE WHEN d.school_id IS NULL THEN NULL ELSE 'derived' END
         FROM derived d
        WHERE c.id = d.id
          AND (c.school_id IS DISTINCT FROM d.school_id)`
    );
    await client.query('COMMIT');
    return { ou_memberships: ouRows, classes_updated: classRows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Schools for a set of users, as { userId: [{ id, name, sources: [...] }] }.
async function schoolsForUsers(userIds) {
  if (!userIds.length) return {};
  const { rows } = await pool.query(
    `SELECT us.user_id, s.id, s.name, array_agg(us.source ORDER BY us.source) AS sources
     FROM user_schools us
     JOIN schools s ON s.id = us.school_id AND s.is_active
     WHERE us.user_id = ANY($1::uuid[])
     GROUP BY us.user_id, s.id, s.name
     ORDER BY s.name`,
    [userIds]
  );
  const out = {};
  for (const r of rows) (out[r.user_id] ||= []).push({ id: r.id, name: r.name, sources: r.sources });
  return out;
}

// Replaces a user's manual school memberships.
async function setManualSchools(userId, schoolIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_schools WHERE user_id = $1 AND source = 'manual'`, [userId]);
    if (schoolIds.length) {
      await client.query(
        `INSERT INTO user_schools (user_id, school_id, source)
         SELECT $1, s.id, 'manual' FROM schools s WHERE s.id = ANY($2::uuid[]) AND s.is_active
         ON CONFLICT DO NOTHING`,
        [userId, schoolIds]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  normalizePrefixes, listSchools, suggestSchools, recompute, schoolsForUsers, setManualSchools,
};
