// Admin "view any student's browser" feature — distinct from the existing
// teacher screenshot-request flow (routes/extension.js) in two ways: it's
// not roster-scoped (admin+, any student, not just a teacher's own class),
// and frames are never persisted to disk/DB (see /extension/liveview-frame) -
// this is meant to feel like a live look, not a permanent record.
//
// Every start/stop is written to device_view_audit (append-only, see
// migration 051) - that table doubles as the session-state source here too:
// the most recent start/stop row for a given (viewer, student) pair IS
// whether a session is currently considered active, no separate table
// needed.
const { Router } = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const events = require('../events');
const { logDeviceView } = require('../services/deviceViewAudit');

const router = Router();
const auth = [authenticate, requirePermission('device_view_audit')];

async function getActiveSession(viewerId, studentId) {
  const { rows: [last] } = await pool.query(
    `SELECT action, created_at FROM device_view_audit
     WHERE viewer_id = $1 AND student_id = $2 AND action IN ('live_view_started', 'live_view_stopped')
     ORDER BY created_at DESC LIMIT 1`,
    [viewerId, studentId]
  );
  return last?.action === 'live_view_started' ? last : null;
}

// POST /api/v1/live-view/:studentId/start
router.post('/:studentId/start', ...auth, async (req, res) => {
  const { studentId } = req.params;
  const { rows: [student] } = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role = 'student'`, [studentId]
  );
  if (!student) return res.status(404).json({ error: 'Student not found' });

  try {
    await logDeviceView({ viewerId: req.user.userId, studentId, action: 'live_view_started' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/live-view/:studentId/stop
router.post('/:studentId/stop', ...auth, async (req, res) => {
  const { studentId } = req.params;
  const active = await getActiveSession(req.user.userId, studentId);
  const durationSeconds = active
    ? Math.round((Date.now() - new Date(active.created_at).getTime()) / 1000)
    : null;

  try {
    await logDeviceView({
      viewerId: req.user.userId, studentId, action: 'live_view_stopped',
      detail: { duration_seconds: durationSeconds },
    });
    res.json({ ok: true, duration_seconds: durationSeconds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/live-view/:studentId/frame
// Asks the student's extension for one more frame. Requires an active
// session (started via /start) so a frame can never be requested without
// a corresponding audit row already on record.
router.post('/:studentId/frame', ...auth, async (req, res) => {
  const { studentId } = req.params;
  const active = await getActiveSession(req.user.userId, studentId);
  if (!active) {
    return res.status(403).json({ error: 'No active live-view session for this student — call /start first' });
  }

  events.emit('admin:liveview_request', { studentId, viewerId: req.user.userId });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/v1/live-view/audit — the accountability backstop itself: every
// row ever written to device_view_audit (live view + screenshot viewing),
// read-only, no delete route anywhere. See migration 051 for why the table
// itself also can't be altered even with direct database access.
// ---------------------------------------------------------------------------
router.get('/audit', ...auth, async (req, res) => {
  const { viewer_id, student_id, action, limit = 100, offset = 0 } = req.query;
  const conditions = [];
  const params = [];

  if (viewer_id)  { conditions.push(`viewer_id = $${params.length+1}`);  params.push(viewer_id); }
  if (student_id) { conditions.push(`student_id = $${params.length+1}`); params.push(student_id); }
  if (action)     { conditions.push(`action = $${params.length+1}`);     params.push(action); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  try {
    const { rows } = await pool.query(
      `SELECT * FROM device_view_audit ${where}
       ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM device_view_audit ${where}`, params
    );
    res.json({ entries: rows, total: parseInt(count, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
