const { Router } = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { resolvePolicy, invalidatePolicy } = require('../services/policyResolver');

const router = Router();

router.use(authenticate, requirePermission('policies'));

// GET /api/v1/assignments
// Optional filters: ?policy_id=&target_type=student|group|ou
router.get('/', async (req, res) => {
  const conditions = [];
  const values     = [];

  if (req.query.policy_id) {
    conditions.push(`pa.policy_id = $${values.length + 1}`);
    values.push(req.query.policy_id);
  }
  if (req.query.target_type) {
    conditions.push(`pa.target_type = $${values.length + 1}`);
    values.push(req.query.target_type);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT pa.*, p.name AS policy_name
     FROM policy_assignments pa
     JOIN policies p ON p.id = pa.policy_id
     ${where}
     ORDER BY pa.target_type, pa.priority DESC`,
    values
  );
  res.json(rows);
});

// POST /api/v1/assignments
// body: { policy_id, target_type: 'student'|'group'|'ou', target_id?, target_ou?, priority? }
router.post('/', async (req, res) => {
  const { policy_id, target_type, target_id = null, target_ou = null, priority = 0 } = req.body;

  if (!policy_id || !target_type) {
    return res.status(400).json({ error: 'policy_id and target_type are required' });
  }
  if (!['student','group','ou'].includes(target_type)) {
    return res.status(400).json({ error: 'target_type must be student, group, or ou' });
  }
  if (target_type !== 'ou' && !target_id) {
    return res.status(400).json({ error: 'target_id required for student/group assignments' });
  }
  if (target_type === 'ou' && !target_ou) {
    return res.status(400).json({ error: 'target_ou required for OU assignments' });
  }

  // Upsert logic differs: student/group use target_id; OU uses target_ou
  let rows;
  if (target_type === 'ou') {
    ({ rows } = await query(
      `INSERT INTO policy_assignments (policy_id, target_type, target_id, target_ou, priority)
       VALUES ($1,$2,NULL,$3,$4)
       ON CONFLICT (policy_id, target_type, target_ou) WHERE target_ou IS NOT NULL
       DO UPDATE SET priority = EXCLUDED.priority
       RETURNING *`,
      [policy_id, target_type, target_ou, priority]
    ));
  } else {
    ({ rows } = await query(
      `INSERT INTO policy_assignments (policy_id, target_type, target_id, target_ou, priority)
       VALUES ($1,$2,$3,NULL,$4)
       ON CONFLICT (policy_id, target_type, target_id) WHERE target_id IS NOT NULL
       DO UPDATE SET priority = EXCLUDED.priority
       RETURNING *`,
      [policy_id, target_type, target_id, priority]
    ));
  }

  // Invalidate cache for the directly-assigned student
  if (target_type === 'student' && target_id) {
    await invalidatePolicy(target_id);
  }

  res.status(201).json(rows[0]);
});

// DELETE /api/v1/assignments/:id
router.delete('/:id', async (req, res) => {
  const { rows } = await query(
    'DELETE FROM policy_assignments WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Assignment not found' });

  if (rows[0].target_type === 'student' && rows[0].target_id) {
    await invalidatePolicy(rows[0].target_id);
  }

  res.json({ deleted: rows[0].id });
});

// GET /api/v1/assignments/effective/:studentId
// Returns the fully-resolved policy for a specific student (admin view)
router.get('/effective/:studentId', async (req, res) => {
  const policy = await resolvePolicy(req.params.studentId);
  res.json(policy);
});

module.exports = router;
