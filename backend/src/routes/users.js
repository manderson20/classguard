const { Router } = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { resolvePolicy } = require('../services/policyResolver');

const router = Router();

// GET /api/v1/users/me/effective-policy
// Shorthand used by the Chrome extension (avoids needing to know own user ID)
router.get('/me/effective-policy', authenticate, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(400).json({ error: 'Effective policy only applies to students' });
  }
  const policy = await resolvePolicy(req.user.userId);

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

// GET /api/v1/users
// Admins see all users; teachers see only students in their classes
router.get('/', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { role, userId } = req.user;
  const { search, google_ou, role: filterRole } = req.query;

  const conditions = [];
  const values     = [];

  if (role === 'teacher') {
    conditions.push(`u.id IN (
      SELECT cm.user_id FROM class_members cm
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
            u.created_at, u.last_synced_at
     FROM users u
     ${where}
     ORDER BY u.full_name`,
    values
  );
  res.json(rows);
});

// GET /api/v1/users/:id
router.get('/:id', authenticate, requireMinRole('admin'), async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.given_name, u.email, u.role, u.google_ou, u.google_id,
            u.created_at, u.last_synced_at
     FROM users u WHERE u.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

// PUT /api/v1/users/:id/role  (superadmin only)
router.put('/:id/role', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { role } = req.body;
  if (!['student','teacher','admin','superadmin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const { rows } = await query(
    'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [role, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
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
       WHERE cm.user_id = $1 AND c.teacher_id = $2
       LIMIT 1`,
      [req.params.id, req.user.userId]
    );
    if (!membership[0]) return res.status(403).json({ error: 'Forbidden' });
  }

  const policy = await resolvePolicy(req.params.id);
  res.json(policy);
});

module.exports = router;
