const { Router } = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermission } = require('../middleware/permissions');
const { resolvePolicy } = require('../services/policyResolver');
const { getEffectivePermissions, invalidatePermissions, UNRESTRICTED } = require('../services/permissions');
const { hashPassword } = require('../services/passwordHash');

const router = Router();

// The id of the builtin custom_roles row for a base role string, or null
// (student has no permission concept at all, so nothing to look up).
async function builtinRoleId(role) {
  if (role === 'student') return null;
  const { rows } = await query(
    'SELECT id FROM custom_roles WHERE base_role = $1 AND is_builtin = true', [role]
  );
  return rows[0]?.id || null;
}

// GET /api/v1/users/me/effective-policy
// Shorthand used by the Chrome extension (avoids needing to know own user ID)
router.get('/me/effective-policy', authenticate, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(400).json({ error: 'Effective policy only applies to students' });
  }
  const policy = await resolvePolicy(req.user.userId, req.query.location);

  // Append YouTube video rules — not cached in policyResolver to keep cache small
  let youtubeAllowVideos = [];
  let youtubeBlockVideos = [];
  if (policy?.id) {
    const { rows } = await query(
      'SELECT video_id, action FROM youtube_video_rules WHERE policy_id = $1',
      [policy.id]
    ).catch(() => ({ rows: [] }));
    youtubeAllowVideos = rows.filter(r => r.action === 'allow').map(r => r.video_id);
    youtubeBlockVideos = rows.filter(r => r.action === 'block').map(r => r.video_id);
  }

  res.json({ ...policy, youtubeAllowVideos, youtubeBlockVideos });
});

// GET /api/v1/users/me/permissions
// Used by the frontend nav (Layout.jsx) to hide admin sections a restricted
// admin can't actually reach — the backend's requirePermission() gates are
// the real enforcement, this is just so the sidebar doesn't show dead links.
router.get('/me/permissions', authenticate, requireMinRole('admin'), async (req, res) => {
  if (req.user.role === 'superadmin') {
    return res.json({ unrestricted: true, permissions: [] });
  }
  const effective = await getEffectivePermissions(req.user.userId);
  res.json(
    effective === UNRESTRICTED
      ? { unrestricted: true, permissions: [] }
      : { unrestricted: false, permissions: [...effective] }
  );
});

// GET /api/v1/users
// Admins see all users; teachers see only students in their classes
router.get('/', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { role, userId } = req.user;
  const { search, google_ou, role: filterRole } = req.query;
  // Capped at 500/page -- a district can have 40-50k users, and an
  // unbounded SELECT * was the previous behavior (fine at hundreds of
  // rows, not at tens of thousands: multi-MB JSON payload, slow render on
  // an unvirtualized table). 500 specifically because PolicySimulator.jsx
  // and PolicyEditor.jsx already request exactly that for their student
  // picker dropdowns -- the Users page itself defaults to 50. limit/offset
  // rather than a cursor since every other list page in this app
  // (live-view/audit, impersonation/audit) already uses the same pattern.
  const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const conditions = [];
  const values     = [];

  if (role === 'teacher') {
    conditions.push(`u.id IN (
      SELECT cm.student_id FROM class_members cm
      JOIN classes c ON c.id = cm.class_id
      WHERE c.teacher_id = $${values.length + 1}
    )`);
    values.push(userId);
  }

  if (search) {
    conditions.push(`(u.full_name ILIKE $${values.length + 1} OR u.email ILIKE $${values.length + 1})`);
    values.push(`%${search}%`);
  }
  if (google_ou) {
    conditions.push(`u.google_ou LIKE $${values.length + 1}`);
    values.push(`${google_ou}%`);
  }
  if (filterRole) {
    conditions.push(`u.role = $${values.length + 1}`);
    values.push(filterRole);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.given_name, u.email, u.role, u.google_ou, u.google_id,
            u.photo_url, u.created_at, u.last_synced_at, u.custom_role_id, cr.name AS custom_role_name
     FROM users u
     LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
     ${where}
     ORDER BY u.full_name
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset]
  );
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*) FROM users u ${where}`, values
  );
  res.json({ users: rows, total: parseInt(count, 10) });
});

// ---------------------------------------------------------------------------
// POST /api/v1/users  (superadmin only)
// Local-password account creation — district staff normally arrive via
// Google Workspace sync, which is exactly why this exists: without it,
// there was no way to create ANY account (test, break-glass, or a real new
// hire) without Google sync running, and no fallback at all if Google SSO
// itself ever broke. google_id gets a 'local:<random>' placeholder, same
// scheme /auth/setup's first-run superadmin already uses, so this is just
// that same account shape, available beyond the very first user.
// ---------------------------------------------------------------------------
router.post('/', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { email, password, fullName, role = 'teacher', custom_role_id: explicitRoleId } = req.body;

  if (!email || !password || !fullName) {
    return res.status(400).json({ error: 'email, password, and fullName are required' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }
  if (!['student','teacher','admin','superadmin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const hash = hashPassword(password);
    const googleId = `local:${crypto.randomBytes(8).toString('hex')}`;
    // Defaults to the role's builtin permission row (Super Admin/Admin/
    // Teacher) so it's actually editable later — unless a specific custom
    // role was chosen instead (only meaningful for 'admin').
    const customRoleId = explicitRoleId || await builtinRoleId(role);

    const { rows } = await query(
      `INSERT INTO users (google_id, email, full_name, given_name, role, password_hash, custom_role_id, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id, email, full_name, role, custom_role_id, created_at`,
      [googleId, email.toLowerCase().trim(), fullName, fullName.split(' ')[0], role, hash, customRoleId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
    console.error('[users] create error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/v1/users/:id/password  (superadmin only)
// Sets or resets a local password for ANY existing user, including one that
// arrived via Google sync and has never had one — the fallback path for "I
// need to get into this account and Google SSO is the problem."
router.put('/:id/password', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }

  const hash = hashPassword(password);
  const { rows } = await query(
    `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id`,
    [hash, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

// GET /api/v1/users/:id
router.get('/:id', authenticate, requirePermission('users'), async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.given_name, u.email, u.role, u.google_ou, u.google_id,
            u.photo_url, u.created_at, u.last_synced_at
     FROM users u WHERE u.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

// PUT /api/v1/users/:id/role  (superadmin only)
// Switches the base role to its builtin permission row (Super Admin/Admin/
// Teacher) by default — pass custom_role_id explicitly to instead land on a
// specific custom role (only meaningful when role is 'admin').
router.put('/:id/role', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { role, custom_role_id: explicitRoleId } = req.body;
  if (!['student','teacher','admin','superadmin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const customRoleId = explicitRoleId !== undefined ? explicitRoleId : await builtinRoleId(role);
  const { rows } = await query(
    'UPDATE users SET role = $1, custom_role_id = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
    [role, customRoleId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  await invalidatePermissions(req.params.id);
  res.json(rows[0]);
});

// PUT /api/v1/users/:id/custom-role  (superadmin only)
// body: { custom_role_id } — null unrestricts (full admin access, today's
// default). Only meaningful for role='admin' users; superadmin is always
// fully unrestricted regardless of this column.
router.put('/:id/custom-role', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { custom_role_id = null } = req.body;
  if (custom_role_id) {
    const { rows: roleRows } = await query('SELECT id FROM custom_roles WHERE id = $1', [custom_role_id]);
    if (!roleRows[0]) return res.status(404).json({ error: 'Custom role not found' });
  }
  const { rows } = await query(
    'UPDATE users SET custom_role_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [custom_role_id, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  await invalidatePermissions(req.params.id);
  res.json(rows[0]);
});

// GET /api/v1/users/:id/effective-policy
// Returns the fully-resolved policy for a student — used by teacher dashboard
// and DNS engine policy API endpoint.
router.get('/:id/effective-policy', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { rows: user } = await query(
    'SELECT id, role FROM users WHERE id = $1',
    [req.params.id]
  );
  if (!user[0]) return res.status(404).json({ error: 'User not found' });
  if (user[0].role !== 'student') {
    return res.status(400).json({ error: 'Effective policy only applies to students' });
  }

  // Teachers can only query their own students
  if (req.user.role === 'teacher') {
    const { rows: membership } = await query(
      `SELECT 1 FROM class_members cm
       JOIN classes c ON c.id = cm.class_id
       WHERE cm.student_id = $1 AND c.teacher_id = $2
       LIMIT 1`,
      [req.params.id, req.user.userId]
    );
    if (!membership[0]) return res.status(403).json({ error: 'Forbidden' });
  }

  const policy = await resolvePolicy(req.params.id, req.query.location);
  res.json(policy);
});

module.exports = router;
