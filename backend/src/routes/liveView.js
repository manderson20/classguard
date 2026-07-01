// "View a student's browser" feature — two distinct access paths sharing
// the same frame-relay mechanism (frames are never persisted to disk/DB,
// see /extension/liveview-frame — this is meant to feel like a live look,
// not a permanent record, for either path):
//
// - Admin+ (device_view_audit permission): not roster-scoped, any student,
//   meant for privacy-sensitive spot-checks. Logged to device_view_audit
//   (append-only, migration 051), same as always.
// - Teacher: roster-scoped via teacherOwnsStudent(), meant for routine
//   full-screen viewing of one of their own students during an active
//   lesson. Logged to teacher_actions instead — the routine classroom-
//   accountability log lock/unlock/open-tab/close-tab already write to,
//   a different accountability category than the admin audit trail.
//
// Each table doubles as its own session-state source: the most recent
// start/stop row for a given (viewer, student) pair IS whether a session
// is currently considered active, no separate table needed for either path.
const { Router } = require('express');
const { pool, query } = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermission } = require('../middleware/permissions');
const { teacherOwnsStudent } = require('../services/teacherRoster');
const events = require('../events');
const { logDeviceView } = require('../services/deviceViewAudit');

const router = Router();
const auth = [authenticate, requireMinRole('teacher')];
const adminAuth = [authenticate, requirePermission('device_view_audit')];

function isAdminViewer(req) {
  return ['admin', 'superadmin'].includes(req.user.role);
}

// Admins go through the existing device_view_audit permission check;
// teachers go through roster ownership instead.
async function requireLiveViewAccess(req, res, next) {
  if (isAdminViewer(req)) {
    return requirePermission('device_view_audit')(req, res, next);
  }
  if (!(await teacherOwnsStudent(req.user.userId, req.params.studentId))) {
    return res.status(403).json({ error: 'This student is not on one of your rosters' });
  }
  return next();
}

async function logTeacherLiveView(req, student_id, action_type, detail = null) {
  let classId = null;
  try {
    const { rows } = await query(
      `SELECT cm.class_id FROM class_members cm
       JOIN classes c ON c.id = cm.class_id
       WHERE cm.student_id = $1 AND c.teacher_id = $2 LIMIT 1`,
      [student_id, req.user.userId]
    );
    classId = rows[0]?.class_id || null;
  } catch { /* best-effort, audit log shouldn't block the action */ }
  await query(
    `INSERT INTO teacher_actions (teacher_id, student_id, class_id, action_type, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.user.userId, student_id, classId, action_type, detail ? JSON.stringify(detail) : null]
  ).catch(() => {});
}

async function getActiveSession(req, studentId) {
  if (isAdminViewer(req)) {
    const { rows: [last] } = await pool.query(
      `SELECT action, created_at FROM device_view_audit
       WHERE viewer_id = $1 AND student_id = $2 AND action IN ('live_view_started', 'live_view_stopped')
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.userId, studentId]
    );
    return last?.action === 'live_view_started' ? last : null;
  }
  const { rows: [last] } = await pool.query(
    `SELECT action_type AS action, created_at FROM teacher_actions
     WHERE teacher_id = $1 AND student_id = $2 AND action_type IN ('live_view', 'live_view_stop')
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.userId, studentId]
  );
  return last?.action === 'live_view' ? last : null;
}

// POST /api/v1/live-view/:studentId/start
router.post('/:studentId/start', ...auth, requireLiveViewAccess, async (req, res) => {
  const { studentId } = req.params;
  const { rows: [student] } = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role = 'student'`, [studentId]
  );
  if (!student) return res.status(404).json({ error: 'Student not found' });

  try {
    if (isAdminViewer(req)) {
      await logDeviceView({ viewerId: req.user.userId, studentId, action: 'live_view_started' });
    } else {
      await logTeacherLiveView(req, studentId, 'live_view');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/live-view/:studentId/stop
router.post('/:studentId/stop', ...auth, requireLiveViewAccess, async (req, res) => {
  const { studentId } = req.params;
  const active = await getActiveSession(req, studentId);
  const durationSeconds = active
    ? Math.round((Date.now() - new Date(active.created_at).getTime()) / 1000)
    : null;

  try {
    if (isAdminViewer(req)) {
      await logDeviceView({
        viewerId: req.user.userId, studentId, action: 'live_view_stopped',
        detail: { duration_seconds: durationSeconds },
      });
    } else {
      await logTeacherLiveView(req, studentId, 'live_view_stop', { duration_seconds: durationSeconds });
    }
    res.json({ ok: true, duration_seconds: durationSeconds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/live-view/:studentId/frame
// Asks the student's extension for one more frame. Requires an active
// session (started via /start) so a frame can never be requested without
// a corresponding audit row already on record.
router.post('/:studentId/frame', ...auth, requireLiveViewAccess, async (req, res) => {
  const { studentId } = req.params;
  const active = await getActiveSession(req, studentId);
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
// itself also can't be altered even with direct database access. Admin-only
// (not part of the shared `auth` above) — this is district-wide, unscoped
// to any one teacher's roster, and mixes in admin-only screenshot-viewing
// history alongside live-view, a different privacy category than a
// teacher's own `teacher_actions` history.
// ---------------------------------------------------------------------------
router.get('/audit', ...adminAuth, async (req, res) => {
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
