const { Router } = require('express');
const { query, withTransaction } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const {
  PERMISSION_CATALOG, PERMISSION_KEYS,
  invalidatePermissionsForRole,
} = require('../services/permissions');

const router = Router();

// Managing what a custom role grants is itself adjacent to privilege
// escalation (same as PUT /users/:id/role) — superadmin-only, never
// delegatable via the permission system this file defines.
router.use(authenticate, requireMinRole('superadmin'));

// GET /api/v1/custom-roles/catalog — the fixed list of permission keys this
// build of ClassGuard knows about, for the frontend's checkbox grid.
router.get('/catalog', (req, res) => {
  res.json(PERMISSION_CATALOG);
});

// GET /api/v1/custom-roles
router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT cr.*, COUNT(DISTINCT u.id) AS user_count
     FROM custom_roles cr
     LEFT JOIN users u ON u.custom_role_id = cr.id
     GROUP BY cr.id
     ORDER BY cr.name`
  );
  res.json(rows);
});

// GET /api/v1/custom-roles/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM custom_roles WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Role not found' });

  const { rows: permRows } = await query(
    'SELECT permission_key FROM custom_role_permissions WHERE role_id = $1',
    [req.params.id]
  );
  const { rows: users } = await query(
    'SELECT id, full_name, email FROM users WHERE custom_role_id = $1 ORDER BY full_name',
    [req.params.id]
  );
  res.json({ ...rows[0], permissions: permRows.map(r => r.permission_key), users });
});

// POST /api/v1/custom-roles
router.post('/', async (req, res) => {
  const { name, description = null } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await query(
    'INSERT INTO custom_roles (name, description) VALUES ($1,$2) RETURNING *',
    [name, description]
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/v1/custom-roles/:id
router.patch('/:id', async (req, res) => {
  const { name, description } = req.body;
  if (name === undefined && description === undefined) {
    return res.status(400).json({ error: 'name or description required' });
  }
  const fields = [];
  const values = [req.params.id];
  if (name        !== undefined) { fields.push(`name = $${values.length + 1}`);        values.push(name); }
  if (description !== undefined) { fields.push(`description = $${values.length + 1}`); values.push(description); }

  const { rows } = await query(
    `UPDATE custom_roles SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Role not found' });
  res.json(rows[0]);
});

// DELETE /api/v1/custom-roles/:id — ON DELETE SET NULL on users.custom_role_id
// means any user assigned this role falls back to unrestricted, not locked out.
router.delete('/:id', async (req, res) => {
  await invalidatePermissionsForRole(req.params.id);
  const { rows } = await query('DELETE FROM custom_roles WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Role not found' });
  res.json({ deleted: rows[0].id });
});

// PUT /api/v1/custom-roles/:id/permissions  body: { permissions: ['users', 'unblock_requests', ...] }
// Replaces the full set in one transaction — simpler for a checkbox-grid UI
// than incremental add/remove endpoints.
router.put('/:id/permissions', async (req, res) => {
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions array required' });

  const invalid = permissions.filter(p => !PERMISSION_KEYS.has(p));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Unknown permission key(s): ${invalid.join(', ')}` });
  }

  const { rows } = await query('SELECT id FROM custom_roles WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Role not found' });

  await withTransaction(async (client) => {
    await client.query('DELETE FROM custom_role_permissions WHERE role_id = $1', [req.params.id]);
    for (const key of permissions) {
      await client.query(
        'INSERT INTO custom_role_permissions (role_id, permission_key) VALUES ($1,$2)',
        [req.params.id, key]
      );
    }
  });

  await invalidatePermissionsForRole(req.params.id);
  res.json({ role_id: req.params.id, permissions });
});

module.exports = router;
