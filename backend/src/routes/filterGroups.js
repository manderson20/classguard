const { Router }  = require('express');
const { query }   = require('../db');
const { authenticate }  = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { invalidatePolicy } = require('../services/policyResolver');
const events = require('../events');

const router = Router();
router.use(authenticate, requireMinRole('admin'));

// ---------------------------------------------------------------------------
// GET /api/v1/filter-groups
// List all filter groups with member count and the assigned policy (if any).
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        g.id, g.name, g.description, g.created_at,
        COUNT(DISTINCT gm.user_id) AS member_count,
        p.id   AS policy_id,
        p.name AS policy_name,
        p.default_action AS policy_default_action
      FROM groups g
      LEFT JOIN group_members gm ON gm.group_id = g.id
      LEFT JOIN policy_assignments pa
             ON pa.target_type = 'group' AND pa.target_id = g.id
      LEFT JOIN policies p ON p.id = pa.policy_id
      WHERE g.group_type = 'filter'
      GROUP BY g.id, p.id
      ORDER BY g.name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/filter-groups
// Create a new filter group (optionally with an immediate policy assignment).
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { name, description = null, policy_id = null } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  try {
    const { rows: [group] } = await query(
      `INSERT INTO groups (name, description, group_type, created_by)
       VALUES ($1, $2, 'filter', $3)
       RETURNING *`,
      [name.trim(), description, req.user.userId]
    );

    if (policy_id) {
      await query(
        `INSERT INTO policy_assignments (policy_id, target_type, target_id, assigned_by, location)
         VALUES ($1, 'group', $2, $3, 'any')
         ON CONFLICT DO NOTHING`,
        [policy_id, group.id, req.user.userId]
      );
    }

    res.status(201).json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/filter-groups/:id
// Detail: group info + members + assigned policy.
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { rows: [group] } = await query(
      `SELECT g.*, p.id AS policy_id, p.name AS policy_name, p.default_action AS policy_default_action
       FROM groups g
       LEFT JOIN policy_assignments pa
              ON pa.target_type = 'group' AND pa.target_id = g.id
       LEFT JOIN policies p ON p.id = pa.policy_id
       WHERE g.id = $1 AND g.group_type = 'filter'`,
      [req.params.id]
    );
    if (!group) return res.status(404).json({ error: 'Filter group not found' });

    const { rows: members } = await query(
      `SELECT u.id, u.full_name, u.email, u.google_ou
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY u.full_name`,
      [req.params.id]
    );

    res.json({ ...group, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/filter-groups/:id
// Rename or update description.
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  const { name, description } = req.body;
  if (name === undefined && description === undefined) {
    return res.status(400).json({ error: 'name or description required' });
  }

  const fields = [];
  const values = [req.params.id];
  if (name        !== undefined) { fields.push(`name = $${values.length + 1}`);        values.push(name.trim()); }
  if (description !== undefined) { fields.push(`description = $${values.length + 1}`); values.push(description); }

  try {
    const { rows: [group] } = await query(
      `UPDATE groups SET ${fields.join(', ')} WHERE id = $1 AND group_type = 'filter' RETURNING *`,
      values
    );
    if (!group) return res.status(404).json({ error: 'Filter group not found' });
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/filter-groups/:id
// Delete the filter group (members are cascade-removed by FK).
// Policy assignment is also cascade-removed.
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { rows: members } = await query(
      `SELECT user_id FROM group_members WHERE group_id = $1`,
      [req.params.id]
    );

    const { rows: [group] } = await query(
      `DELETE FROM groups WHERE id = $1 AND group_type = 'filter' RETURNING id`,
      [req.params.id]
    );
    if (!group) return res.status(404).json({ error: 'Filter group not found' });

    // Invalidate policy cache for every former member
    await Promise.all(
      members.map(m => invalidatePolicy(m.user_id).catch(() => {}))
    );
    for (const m of members) {
      events.emit('policy:updated', { studentId: m.user_id });
    }

    res.json({ deleted: group.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/filter-groups/:id/policy
// Assign (or replace) the filter policy for this group.
// body: { policy_id }
// ---------------------------------------------------------------------------
router.put('/:id/policy', async (req, res) => {
  const { policy_id } = req.body;
  if (!policy_id) return res.status(400).json({ error: 'policy_id required' });

  try {
    // Verify the group exists and is a filter group
    const { rows: [group] } = await query(
      `SELECT id FROM groups WHERE id = $1 AND group_type = 'filter'`,
      [req.params.id]
    );
    if (!group) return res.status(404).json({ error: 'Filter group not found' });

    // Replace any existing assignment for this group
    await query(
      `DELETE FROM policy_assignments WHERE target_type = 'group' AND target_id = $1`,
      [req.params.id]
    );
    await query(
      `INSERT INTO policy_assignments (policy_id, target_type, target_id, assigned_by, location)
       VALUES ($1, 'group', $2, $3, 'any')`,
      [policy_id, req.params.id, req.user.userId]
    );

    // Invalidate policy cache for all members
    const { rows: members } = await query(
      `SELECT user_id FROM group_members WHERE group_id = $1`,
      [req.params.id]
    );
    await Promise.all(
      members.map(m => invalidatePolicy(m.user_id).catch(() => {}))
    );
    for (const m of members) {
      events.emit('policy:updated', { studentId: m.user_id });
    }

    res.json({ ok: true, group_id: req.params.id, policy_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/filter-groups/:id/policy
// Unassign the policy from this group.
// ---------------------------------------------------------------------------
router.delete('/:id/policy', async (req, res) => {
  try {
    await query(
      `DELETE FROM policy_assignments WHERE target_type = 'group' AND target_id = $1`,
      [req.params.id]
    );

    const { rows: members } = await query(
      `SELECT user_id FROM group_members WHERE group_id = $1`,
      [req.params.id]
    );
    await Promise.all(
      members.map(m => invalidatePolicy(m.user_id).catch(() => {}))
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/filter-groups/:id/members
// Add a student to the filter group. Body: { user_id } or { email }.
// ---------------------------------------------------------------------------
router.post('/:id/members', async (req, res) => {
  let { user_id, email } = req.body;

  try {
    // Verify group exists
    const { rows: [group] } = await query(
      `SELECT id FROM groups WHERE id = $1 AND group_type = 'filter'`,
      [req.params.id]
    );
    if (!group) return res.status(404).json({ error: 'Filter group not found' });

    if (!user_id && email) {
      const { rows: [u] } = await query(
        `SELECT id FROM users WHERE email = $1 AND role = 'student'`,
        [email.toLowerCase()]
      );
      if (!u) return res.status(404).json({ error: 'Student not found with that email' });
      user_id = u.id;
    }
    if (!user_id) return res.status(400).json({ error: 'user_id or email required' });

    await query(
      `INSERT INTO group_members (group_id, user_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.params.id, user_id, req.user.userId]
    );

    await invalidatePolicy(user_id).catch(() => {});
    events.emit('policy:updated', { studentId: user_id });

    res.status(201).json({ group_id: req.params.id, user_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/filter-groups/:id/members/:userId
// Remove a student from the filter group.
// ---------------------------------------------------------------------------
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    await query(
      `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );

    await invalidatePolicy(req.params.userId).catch(() => {});
    events.emit('policy:updated', { studentId: req.params.userId });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
