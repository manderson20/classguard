const { Router } = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { invalidatePolicy } = require('../services/policyResolver');
const events = require('../events');

const router = Router();

router.use(authenticate, requireMinRole('teacher'));

// GET /api/v1/penalty-box
// Returns active entries; teachers see their class members only (unless admin+)
router.get('/', async (req, res) => {
  const { role, userId } = req.user;

  let sql = `
    SELECT pb.*, u.full_name AS student_name, u.email AS student_email,
           p.full_name AS placed_by_name
    FROM penalty_box pb
    JOIN users u ON u.id = pb.student_id
    LEFT JOIN users p ON p.id = pb.placed_by
    WHERE pb.released_at IS NULL
      AND (pb.expires_at IS NULL OR pb.expires_at > NOW())
  `;
  const values = [];

  if (role === 'teacher') {
    sql += ` AND EXISTS (
      SELECT 1 FROM class_members cm
      JOIN classes c ON c.id = cm.class_id
      WHERE cm.student_id = pb.student_id AND c.teacher_id = $1
    )`;
    values.push(userId);
  }

  sql += ' ORDER BY pb.placed_at DESC';
  const { rows } = await query(sql, values);
  res.json(rows);
});

// POST /api/v1/penalty-box
// body: { student_id, reason?, expires_at? (ISO8601 or null for indefinite) }
router.post('/', async (req, res) => {
  const { student_id, reason = null, expires_at = null } = req.body;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });

  // Upsert: if already penalised, extend/replace the entry
  const { rows } = await query(
    `INSERT INTO penalty_box (student_id, placed_by, reason, expires_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (student_id) WHERE released_at IS NULL
     DO UPDATE SET
       placed_by  = EXCLUDED.placed_by,
       reason     = EXCLUDED.reason,
       expires_at = EXCLUDED.expires_at,
       placed_at  = NOW()
     RETURNING *`,
    [student_id, req.user.userId, reason, expires_at]
  );

  await invalidatePolicy(student_id);
  events.emit('policy:updated', { studentId: student_id });

  res.status(201).json(rows[0]);
});

// DELETE /api/v1/penalty-box/:studentId
// Release a student from the penalty box
router.delete('/:studentId', async (req, res) => {
  const { rows } = await query(
    `UPDATE penalty_box
     SET released_at = NOW(), released_by = $1
     WHERE student_id = $2
       AND released_at IS NULL
     RETURNING *`,
    [req.user.userId, req.params.studentId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No active penalty box entry found' });

  await invalidatePolicy(req.params.studentId);
  events.emit('policy:updated', { studentId: req.params.studentId });

  res.json(rows[0]);
});

module.exports = router;
