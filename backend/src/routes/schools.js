// Schools (migration 103, services/schools.js). Managed on the Roster Sync
// page ('roster' permission); the plain list is readable by any staff
// account, since later features (ISS, SCORM sharing) let staff pick schools.
const { Router } = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermission } = require('../middleware/permissions');
const schools = require('../services/schools');

const router = Router();
const manage = [authenticate, requirePermission('roster')];

// GET /api/v1/schools — active schools; ?counts=1 (admins) adds member counts,
// ?all=1 (admins) includes archived ones.
router.get('/', authenticate, requireMinRole('teacher'), async (req, res) => {
  const adminPlus = ['admin', 'superadmin'].includes(req.user.role);
  const rows = await schools.listSchools({
    includeInactive: adminPlus && req.query.all === '1',
    withCounts:      adminPlus && req.query.counts === '1',
  });
  if (adminPlus) return res.json(rows);
  res.json(rows.map(({ id, name }) => ({ id, name })));
});

// GET /api/v1/schools/suggestions — schools suggested from the Google OU tree
router.get('/suggestions', ...manage, async (req, res) => {
  res.json(await schools.suggestSchools());
});

function validName(name) {
  const n = String(name || '').trim();
  return n.length >= 1 && n.length <= 120 ? n : null;
}

// POST /api/v1/schools  body: { name, ou_prefixes: [] }
router.post('/', ...manage, async (req, res) => {
  const name = validName(req.body.name);
  if (!name) return res.status(400).json({ error: 'A school name (1–120 characters) is required' });
  const prefixes = schools.normalizePrefixes(req.body.ou_prefixes);
  try {
    const { rows: [row] } = await query(
      `INSERT INTO schools (name, ou_prefixes) VALUES ($1, $2) RETURNING *`,
      [name, prefixes]
    );
    const result = await schools.recompute();
    res.status(201).json({ ...row, recompute: result });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A school with this name already exists' });
    throw err;
  }
});

// PATCH /api/v1/schools/:id  body: { name?, ou_prefixes?, is_active? }
router.patch('/:id', ...manage, async (req, res) => {
  const sets = [];
  const values = [req.params.id];
  if (req.body.name !== undefined) {
    const name = validName(req.body.name);
    if (!name) return res.status(400).json({ error: 'A school name (1–120 characters) is required' });
    values.push(name); sets.push(`name = $${values.length}`);
  }
  if (req.body.ou_prefixes !== undefined) {
    values.push(schools.normalizePrefixes(req.body.ou_prefixes)); sets.push(`ou_prefixes = $${values.length}`);
  }
  if (req.body.is_active !== undefined) {
    if (typeof req.body.is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false' });
    values.push(req.body.is_active); sets.push(`is_active = $${values.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    const { rows: [row] } = await query(
      `UPDATE schools SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      values
    );
    if (!row) return res.status(404).json({ error: 'School not found' });
    const result = await schools.recompute();
    res.json({ ...row, recompute: result });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A school with this name already exists' });
    throw err;
  }
});

// POST /api/v1/schools/recompute — rebuild OU memberships and class schools now
router.post('/recompute', ...manage, async (req, res) => {
  res.json(await schools.recompute());
});

module.exports = router;
