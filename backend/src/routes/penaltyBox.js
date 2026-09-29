const { Router } = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { invalidatePolicy } = require('../services/policyResolver');
const { teacherOwnsStudent } = require('../services/teacherRoster');
const events = require('../events');

const router = Router();

router.use(authenticate, requireMinRole('teacher'));

// "Allow site…" accepts a domain or a pasted URL; store just the hostname
// (without a leading www., so the grant covers the site's subdomains too —
// DNS and the extension both match subdomains of an allowed domain).
function toHostname(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return null;
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
}

// Teachers may only restrict, release or request sites for students on one
// of their own rosters (same rule as GET below); admins aren't scoped.
async function forbidUnlessOwnStudent(req, res, studentId) {
  if (req.user.role !== 'teacher') return false;
  if (await teacherOwnsStudent(req.user.userId, studentId)) return false;
  res.status(403).json({ error: 'Student is not in your class' });
  return true;
}

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
  if (await forbidUnlessOwnStudent(req, res, student_id)) return;

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

// POST /api/v1/penalty-box/:studentId/allow-request
// Teacher submits a site-access request for a penalty box student to an admin.
// Verifies the student is in the teacher's class and is currently restricted.
router.post('/:studentId/allow-request', async (req, res) => {
  const { userId } = req.user;
  const { studentId } = req.params;
  const { reason } = req.body;
  const domain = toHostname(req.body.domain);
  if (!domain) return res.status(400).json({ error: 'A valid domain or URL is required' });

  if (await forbidUnlessOwnStudent(req, res, studentId)) return;

  const { rows: [active] } = await query(
    `SELECT id FROM penalty_box WHERE student_id = $1 AND released_at IS NULL`,
    [studentId]
  );
  if (!active) return res.status(400).json({ error: 'Student is not currently restricted' });

  const { rows: [teacher] } = await query(
    `SELECT full_name, email FROM users WHERE id = $1`, [userId]
  );

  try {
    const { rows: [request] } = await query(
      `INSERT INTO unblock_requests
         (domain, student_id, requester_email, requester_name, reason, source_ip, penalty_box_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, domain, status, requested_at`,
      [
        domain,
        studentId,
        teacher.email,
        `${teacher.full_name || teacher.email} (on behalf of student)`,
        reason?.trim() || null,
        req.ip || null,
        active.id,
      ]
    );
    res.status(201).json(request);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A pending request for this domain already exists' });
    console.error('[penalty-box/allow-request]', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// DELETE /api/v1/penalty-box/:studentId
// Release a student from the penalty box
router.delete('/:studentId', async (req, res) => {
  if (await forbidUnlessOwnStudent(req, res, req.params.studentId)) return;

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
