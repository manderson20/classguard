const { Router } = require('express');
const { pool, query, withTransaction } = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = Router();
const adminAuth = [authenticate, requirePermission('bell_schedule')];

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

router.get('/schedules', ...adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT bs.*, COUNT(DISTINCT bsp.id) AS period_count, COUNT(DISTINCT ba.id) AS assignment_count
     FROM bell_schedules bs
     LEFT JOIN bell_schedule_periods bsp ON bsp.schedule_id = bs.id
     LEFT JOIN bell_schedule_assignments ba ON ba.schedule_id = bs.id
     GROUP BY bs.id
     ORDER BY bs.is_default DESC, bs.name`
  );
  res.json(rows);
});

router.post('/schedules', ...adminAuth, async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO bell_schedules (name, description) VALUES ($1, $2) RETURNING *`,
      [name.trim(), description?.trim() || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A schedule with that name already exists' });
    console.error('[bell-schedule] create schedule error:', err);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

router.patch('/schedules/:id', ...adminAuth, async (req, res) => {
  const { name, description } = req.body;
  if (name === undefined && description === undefined) {
    return res.status(400).json({ error: 'name or description required' });
  }
  const fields = [], values = [req.params.id];
  if (name        !== undefined) { fields.push(`name = $${values.length + 1}`);        values.push(name.trim()); }
  if (description !== undefined) { fields.push(`description = $${values.length + 1}`); values.push(description?.trim() || null); }
  const { rows } = await pool.query(
    `UPDATE bell_schedules SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Schedule not found' });
  res.json(rows[0]);
});

// Deleting a schedule cascades to its periods and assignments. Any student
// who only matched via this schedule's assignment rules falls back to
// whichever schedule is currently the default -- never left with no
// schedule at all.
router.delete('/schedules/:id', ...adminAuth, async (req, res) => {
  const { rows: existing } = await pool.query('SELECT is_default FROM bell_schedules WHERE id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: 'Schedule not found' });
  if (existing[0].is_default) {
    return res.status(403).json({ error: 'Cannot delete the default schedule -- set another schedule as default first' });
  }
  await pool.query('DELETE FROM bell_schedules WHERE id = $1', [req.params.id]);
  res.json({ deleted: req.params.id });
});

// PUT /api/v1/bell-schedule/schedules/:id/default
router.put('/schedules/:id/default', ...adminAuth, async (req, res) => {
  const { rows } = await withTransaction(async (client) => {
    await client.query('UPDATE bell_schedules SET is_default = false WHERE is_default = true');
    return client.query('UPDATE bell_schedules SET is_default = true, updated_at = NOW() WHERE id = $1 RETURNING *', [req.params.id]);
  });
  if (!rows[0]) return res.status(404).json({ error: 'Schedule not found' });
  res.json(rows[0]);
});

// ---------------------------------------------------------------------------
// Periods — scoped to a schedule. period_label must match whatever string
// the roster sync (OneRoster / Infinite Campus) puts in classes.period —
// there's no validation against that table here since periods can be
// entered before a class using them ever syncs.
// ---------------------------------------------------------------------------

router.get('/periods', ...adminAuth, async (req, res) => {
  const { schedule_id } = req.query;
  if (!schedule_id) return res.status(400).json({ error: 'schedule_id query param required' });
  const { rows } = await pool.query(
    `SELECT * FROM bell_schedule_periods WHERE schedule_id = $1 ORDER BY start_time`,
    [schedule_id]
  );
  res.json(rows);
});

router.post('/periods', ...adminAuth, async (req, res) => {
  const { schedule_id, period_label, name, start_time, end_time, days_of_week } = req.body;
  if (!schedule_id || !period_label || !start_time || !end_time) {
    return res.status(400).json({ error: 'schedule_id, period_label, start_time, and end_time are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO bell_schedule_periods (schedule_id, period_label, name, start_time, end_time, days_of_week)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [schedule_id, period_label.trim(), name?.trim() || null, start_time, end_time, days_of_week || [1, 2, 3, 4, 5]]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This period label already has a schedule entry on this schedule' });
    console.error('[bell-schedule] POST period error:', err);
    res.status(500).json({ error: 'Failed to create period' });
  }
});

router.patch('/periods/:id', ...adminAuth, async (req, res) => {
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

router.delete('/periods/:id', ...adminAuth, async (req, res) => {
  await pool.query(`DELETE FROM bell_schedule_periods WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Assignments — which schedule a student resolves to, via EITHER OU prefix
// match OR exact grade_level match (never both — gated by the
// bell_schedule_match_mode setting below). Listed across all schedules in
// one place so an admin can see the whole picture at a glance.
// ---------------------------------------------------------------------------

router.get('/assignments', ...adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ba.*, bs.name AS schedule_name
     FROM bell_schedule_assignments ba
     JOIN bell_schedules bs ON bs.id = ba.schedule_id
     ORDER BY ba.target_type, COALESCE(ba.target_ou, ba.target_grade_level)`
  );
  res.json(rows);
});

router.post('/assignments', ...adminAuth, async (req, res) => {
  const { schedule_id, target_type, target_ou, target_grade_level } = req.body;
  if (!schedule_id || !['ou', 'grade_level'].includes(target_type)) {
    return res.status(400).json({ error: 'schedule_id and a valid target_type are required' });
  }
  if (target_type === 'ou' && !target_ou?.trim()) {
    return res.status(400).json({ error: 'target_ou is required for an OU-based assignment' });
  }
  if (target_type === 'grade_level' && !target_grade_level?.trim()) {
    return res.status(400).json({ error: 'target_grade_level is required for a grade-level-based assignment' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO bell_schedule_assignments (schedule_id, target_type, target_ou, target_grade_level)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [schedule_id, target_type,
       target_type === 'ou' ? target_ou.trim() : null,
       target_type === 'grade_level' ? target_grade_level.trim() : null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This OU or grade level is already assigned to a schedule' });
    console.error('[bell-schedule] POST assignment error:', err);
    res.status(500).json({ error: 'Failed to create assignment' });
  }
});

router.delete('/assignments/:id', ...adminAuth, async (req, res) => {
  await pool.query(`DELETE FROM bell_schedule_assignments WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Match mode — district-wide choice of OU vs grade-level matching. A
// dedicated setting (rather than the generic /settings endpoint) so an
// admin with only the bell_schedule permission, not the broader settings
// one, can still configure this.
// ---------------------------------------------------------------------------

router.get('/match-mode', ...adminAuth, async (req, res) => {
  const { rows } = await query(`SELECT value FROM settings WHERE key = 'bell_schedule_match_mode'`);
  res.json({ mode: rows[0]?.value || 'grade_level' });
});

router.put('/match-mode', ...adminAuth, async (req, res) => {
  const { mode } = req.body;
  if (!['ou', 'grade_level'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'ou' or 'grade_level'" });
  }
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('bell_schedule_match_mode', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [mode]
  );
  res.json({ mode });
});

// GET /api/v1/bell-schedule/ou-list — same data as policies.js's ou-list,
// duplicated rather than imported so this route stays gated purely by the
// bell_schedule permission instead of also requiring 'policies'.
router.get('/ou-list', ...adminAuth, async (req, res) => {
  const [fromSettings, fromUsers, fromAssignments] = await Promise.all([
    query(`SELECT value FROM settings WHERE key = 'google_ous'`),
    query(`SELECT DISTINCT google_ou AS path FROM users
           WHERE google_ou IS NOT NULL AND google_ou <> ''`),
    query(`SELECT DISTINCT target_ou AS path FROM bell_schedule_assignments
           WHERE target_type = 'ou' AND target_ou IS NOT NULL`),
  ]);
  const paths = new Set();
  if (fromSettings.rows[0]?.value) {
    try { JSON.parse(fromSettings.rows[0].value).forEach(p => paths.add(p)); } catch {}
  }
  fromUsers.rows.forEach(r => paths.add(r.path));
  fromAssignments.rows.forEach(r => paths.add(r.path));
  res.json([...paths].sort());
});

// GET /api/v1/bell-schedule/grade-levels — distinct grade_level values
// actually present among synced students, so the assignment picker can
// offer real values instead of guessing a format.
router.get('/grade-levels', ...adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT grade_level FROM users
     WHERE role = 'student' AND grade_level IS NOT NULL AND grade_level <> ''
     ORDER BY grade_level`
  );
  res.json(rows.map(r => r.grade_level));
});

module.exports = router;
