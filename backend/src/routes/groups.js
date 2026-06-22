const { Router } = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = Router();

router.use(authenticate, requirePermission('groups'));

// GET /api/v1/groups
router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT g.*, COUNT(gm.user_id) AS member_count
     FROM groups g
     LEFT JOIN group_members gm ON gm.group_id = g.id
     GROUP BY g.id
     ORDER BY g.name`
  );
  res.json(rows);
});

// GET /api/v1/groups/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM groups WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Group not found' });

  const { rows: members } = await query(
    `SELECT u.id, u.full_name, u.email, u.role, u.google_ou
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1
     ORDER BY u.full_name`,
    [req.params.id]
  );
  res.json({ ...rows[0], members });
});

// POST /api/v1/groups
router.post('/', async (req, res) => {
  const { name, description = null } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await query(
    'INSERT INTO groups (name, description) VALUES ($1,$2) RETURNING *',
    [name, description]
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/v1/groups/:id
router.patch('/:id', async (req, res) => {
  const { name, description } = req.body;
  if (name === undefined && description === undefined) {
    return res.status(400).json({ error: 'name or description required' });
  }
  const fields  = [];
  const values  = [req.params.id];
  if (name        !== undefined) { fields.push(`name = $${values.length + 1}`);        values.push(name); }
  if (description !== undefined) { fields.push(`description = $${values.length + 1}`); values.push(description); }

  const { rows } = await query(
    `UPDATE groups SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Group not found' });
  res.json(rows[0]);
});

// DELETE /api/v1/groups/:id
router.delete('/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM groups WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Group not found' });
  res.json({ deleted: rows[0].id });
});

// POST /api/v1/groups/:id/members  body: { user_id } or { email }
router.post('/:id/members', async (req, res) => {
  let { user_id, email } = req.body;

  if (!user_id && email) {
    const { rows } = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found with that email' });
    user_id = rows[0].id;
  }

  if (!user_id) return res.status(400).json({ error: 'user_id or email required' });

  await query(
    'INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.params.id, user_id]
  );
  res.status(201).json({ group_id: req.params.id, user_id });
});

// DELETE /api/v1/groups/:id/members/:userId
router.delete('/:id/members/:userId', async (req, res) => {
  await query(
    'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
    [req.params.id, req.params.userId]
  );
  res.json({ ok: true });
});

module.exports = router;
