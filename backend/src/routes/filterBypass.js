// Filter bypass alerts -- see services/filterBypassDetection.js for the
// detection logic. Same permission as Safety Alerts since this is the same
// audience/domain (a circumvented filter is a student-safety concern, not
// an infra one).
const { Router } = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { runDetection } = require('../services/filterBypassDetection');

const router = Router();
const auth = [authenticate, requirePermission('safety_alerts')];

router.get('/', ...auth, async (req, res) => {
  const { status } = req.query;
  const conditions = [];
  const params = [];
  if (status) { conditions.push(`fba.status = $${params.length + 1}`); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT fba.*, u.full_name AS student_name, u.email AS student_email
     FROM filter_bypass_alerts fba
     LEFT JOIN users u ON u.id = fba.student_id
     ${where}
     ORDER BY fba.last_checked_at DESC LIMIT 100`,
    params
  );
  res.json(rows);
});

router.post('/:id/resolve', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE filter_bypass_alerts SET status = 'resolved', resolved_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
  res.json(rows[0]);
});

// Manual trigger for testing/on-demand checks, same pattern as Security
// Scan's "Run Scan Now".
router.post('/run', ...auth, async (req, res) => {
  try {
    const result = await runDetection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
