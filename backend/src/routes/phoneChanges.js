// Phone change workflow — tracks extension/room reassignments per move
// period (e.g. "Summer 2026"), each with its own checklist of tasks (not
// just "rename the extension" — voicemail reset, user account update, etc).
// Mounted at /api/v1/phones (same auth as the rest of the Phone System).
const express = require('express');
const { query, pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();
router.use(authenticate, requirePermission('phones'));

// ---------------------------------------------------------------------------
// Change periods
// ---------------------------------------------------------------------------
router.get('/change-periods', async (req, res) => {
  const { rows } = await query(`
    SELECT p.*,
      COUNT(c.id) AS total_changes,
      COUNT(c.id) FILTER (WHERE c.status = 'completed') AS completed_changes
    FROM phone_change_periods p
    LEFT JOIN phone_changes c ON c.period_id = p.id
    GROUP BY p.id
    ORDER BY p.start_date DESC NULLS LAST, p.created_at DESC
  `);
  res.json(rows);
});

router.post('/change-periods', async (req, res) => {
  const { name, start_date, end_date, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows: [row] } = await query(
    `INSERT INTO phone_change_periods (name, start_date, end_date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, start_date || null, end_date || null, notes || null, req.user.userId]
  );
  res.status(201).json(row);
});

router.put('/change-periods/:id', async (req, res) => {
  const { name, start_date, end_date, status, notes } = req.body;
  const { rows: [row] } = await query(
    `UPDATE phone_change_periods SET
       name=$1, start_date=$2, end_date=$3, status=$4, notes=$5, updated_at=NOW()
     WHERE id=$6 RETURNING *`,
    [name, start_date || null, end_date || null, status || 'planning', notes || null, req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.delete('/change-periods/:id', async (req, res) => {
  const { rows: [row] } = await query('DELETE FROM phone_change_periods WHERE id = $1 RETURNING *', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: row });
});

// ---------------------------------------------------------------------------
// Task templates (reusable checklists, e.g. "Standard Teacher Move")
// ---------------------------------------------------------------------------
router.get('/change-task-templates', async (req, res) => {
  const { rows: templates } = await query('SELECT * FROM phone_change_task_templates ORDER BY name');
  const { rows: items } = await query('SELECT * FROM phone_change_task_template_items ORDER BY sort_order');
  const byTemplate = new Map();
  for (const i of items) {
    if (!byTemplate.has(i.template_id)) byTemplate.set(i.template_id, []);
    byTemplate.get(i.template_id).push(i);
  }
  res.json(templates.map(t => ({ ...t, items: byTemplate.get(t.id) || [] })));
});

router.post('/change-task-templates', async (req, res) => {
  const { name, items = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [template] } = await client.query(
      'INSERT INTO phone_change_task_templates (name) VALUES ($1) RETURNING *', [name]
    );
    const safeItems = items.slice(0, 500);
    for (let i = 0; i < safeItems.length; i++) {
      await client.query(
        'INSERT INTO phone_change_task_template_items (template_id, label, sort_order) VALUES ($1,$2,$3)',
        [template.id, safeItems[i], i]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(template);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/change-task-templates/:id', async (req, res) => {
  const { rows: [row] } = await query('DELETE FROM phone_change_task_templates WHERE id = $1 RETURNING *', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: row });
});

// ---------------------------------------------------------------------------
// Changes — one per phone/room move within a period
// ---------------------------------------------------------------------------
router.get('/change-periods/:periodId/changes', async (req, res) => {
  const { rows: changes } = await query(`
    SELECT c.*, ph.device_id, ph.display_name AS current_display_name
    FROM phone_changes c
    LEFT JOIN phones ph ON ph.id = c.phone_id
    WHERE c.period_id = $1
    ORDER BY c.building, c.room_number
  `, [req.params.periodId]);

  const { rows: tasks } = await query(`
    SELECT t.* FROM phone_change_tasks t
    JOIN phone_changes c ON c.id = t.change_id
    WHERE c.period_id = $1
    ORDER BY t.sort_order
  `, [req.params.periodId]);

  const byChange = new Map();
  for (const t of tasks) {
    if (!byChange.has(t.change_id)) byChange.set(t.change_id, []);
    byChange.get(t.change_id).push(t);
  }
  res.json(changes.map(c => ({ ...c, tasks: byChange.get(c.id) || [] })));
});

// Body: { phone_id, extension, building, room_number, previous_occupant,
//         new_occupant, notes, template_id | tasks: [labels] }
router.post('/change-periods/:periodId/changes', async (req, res) => {
  const f = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [change] } = await client.query(
      `INSERT INTO phone_changes (period_id, phone_id, extension, building, room_number,
          previous_occupant, new_occupant, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.periodId, f.phone_id || null, f.extension || null, f.building || null, f.room_number || null,
       f.previous_occupant || null, f.new_occupant || null, f.notes || null, req.user.userId]
    );

    let taskLabels = f.tasks || [];
    if (f.template_id) {
      const { rows: items } = await client.query(
        'SELECT label FROM phone_change_task_template_items WHERE template_id = $1 ORDER BY sort_order',
        [f.template_id]
      );
      taskLabels = items.map(i => i.label);
    }
    const safeLabels = taskLabels.slice(0, 500);
    for (let i = 0; i < safeLabels.length; i++) {
      await client.query(
        'INSERT INTO phone_change_tasks (change_id, label, sort_order) VALUES ($1,$2,$3)',
        [change.id, safeLabels[i], i]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(change);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.put('/changes/:id', async (req, res) => {
  const f = req.body;
  const { rows: [row] } = await query(
    `UPDATE phone_changes SET
       phone_id=$1, extension=$2, building=$3, room_number=$4,
       previous_occupant=$5, new_occupant=$6, status=$7, notes=$8,
       completed_at = CASE WHEN $7 = 'completed' AND status != 'completed' THEN NOW()
                           WHEN $7 != 'completed' THEN NULL ELSE completed_at END,
       updated_at=NOW()
     WHERE id=$9 RETURNING *`,
    [f.phone_id || null, f.extension || null, f.building || null, f.room_number || null,
     f.previous_occupant || null, f.new_occupant || null, f.status || 'pending', f.notes || null, req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.delete('/changes/:id', async (req, res) => {
  const { rows: [row] } = await query('DELETE FROM phone_changes WHERE id = $1 RETURNING *', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: row });
});

// Add an ad-hoc task to an existing change (on top of whatever the template gave it)
router.post('/changes/:id/tasks', async (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ error: 'label is required' });
  const { rows: [{ next }] } = await query(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM phone_change_tasks WHERE change_id = $1',
    [req.params.id]
  );
  const { rows: [row] } = await query(
    'INSERT INTO phone_change_tasks (change_id, label, sort_order) VALUES ($1,$2,$3) RETURNING *',
    [req.params.id, label, next]
  );
  res.status(201).json(row);
});

router.put('/change-tasks/:id', async (req, res) => {
  const { is_done } = req.body;
  const { rows: [row] } = await query(
    `UPDATE phone_change_tasks SET is_done=$1, done_by=$2, done_at=$3 WHERE id=$4 RETURNING *`,
    [!!is_done, is_done ? req.user.userId : null, is_done ? new Date() : null, req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });

  // Auto-promote the parent change's status based on task completion —
  // saves a manual status click for the common case, but PUT /changes/:id
  // can still always override it directly.
  const { rows: [change] } = await query('SELECT change_id FROM phone_change_tasks WHERE id = $1', [req.params.id]);
  if (change) {
    const { rows: [{ total, done }] } = await query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_done) AS done
       FROM phone_change_tasks WHERE change_id = $1`,
      [change.change_id]
    );
    const newStatus = total > 0 && total === done ? 'completed' : (done > 0 ? 'in_progress' : 'pending');
    await query(
      `UPDATE phone_changes SET status=$1, completed_at = CASE WHEN $1='completed' THEN NOW() ELSE NULL END, updated_at=NOW()
       WHERE id=$2 AND status != 'cancelled'`,
      [newStatus, change.change_id]
    );
  }
  res.json(row);
});

module.exports = router;
