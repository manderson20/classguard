const { Router } = require('express');
const { pool }   = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

const router = Router();
const adminAuth = [authenticate, requireMinRole('admin')];

// period_label must match whatever string the roster sync (OneRoster /
// Infinite Campus) puts in classes.period — there's no validation against
// that table here since periods can be entered before a class using them
// ever syncs.
router.get('/', ...adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM bell_schedule_periods ORDER BY start_time`
  );
  res.json(rows);
});

router.post('/', ...adminAuth, async (req, res) => {
  const { period_label, name, start_time, end_time, days_of_week } = req.body;
  if (!period_label || !start_time || !end_time) {
    return res.status(400).json({ error: 'period_label, start_time, and end_time are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO bell_schedule_periods (period_label, name, start_time, end_time, days_of_week)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [period_label.trim(), name?.trim() || null, start_time, end_time, days_of_week || [1, 2, 3, 4, 5]]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This period label already has a schedule entry' });
    console.error('[bell-schedule] POST error:', err);
    res.status(500).json({ error: 'Failed to create period' });
  }
});

router.patch('/:id', ...adminAuth, async (req, res) => {
  const { name, start_time, end_time, days_of_week } = req.body;
  const sets = [], params = [];
  if (name !== undefined)         { sets.push(`name = $${params.length+1}`);         params.push(name); }
  if (start_time !== undefined)   { sets.push(`start_time = $${params.length+1}`);   params.push(start_time); }
  if (end_time !== undefined)     { sets.push(`end_time = $${params.length+1}`);     params.push(end_time); }
  if (days_of_week !== undefined) { sets.push(`days_of_week = $${params.length+1}`); params.push(days_of_week); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push(`updated_at = NOW()`);

  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE bell_schedule_periods SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

router.delete('/:id', ...adminAuth, async (req, res) => {
  await pool.query(`DELETE FROM bell_schedule_periods WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
