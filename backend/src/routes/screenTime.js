const { Router } = require('express');
const { pool }   = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { teacherOwnsStudent } = require('../services/teacherRoster');

const router = Router();

// Pure recording/reporting — no limits or enforcement. Built from
// screen_time_intervals (migration 057), itself stitched from the
// extension's existing 30s heartbeat + chrome.idle state. Covers
// Chromebooks and Macs (same extension) — iPads are out of scope, Apple
// does not expose comparable usage data to MDM at any level.

// ---------------------------------------------------------------------------
// GET /api/v1/screen-time/summary?from=&to=&limit=&offset=
// Per-student total active minutes in the range — the "who's a heavy user"
// list view. Teachers are roster-limited like every other student-data
// endpoint in this codebase.
// ---------------------------------------------------------------------------
router.get('/summary', authenticate, requireMinRole('teacher'), async (req, res) => {
  const from   = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400_000);
  const to     = req.query.to   ? new Date(req.query.to)   : new Date();
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const rosterClause = req.user.role === 'teacher'
    ? `AND u.id IN (SELECT cm.student_id FROM class_members cm JOIN classes c ON c.id = cm.class_id WHERE c.teacher_id = $4)`
    : '';
  const params = [from, to, limit, offset];
  if (req.user.role === 'teacher') params.push(req.user.userId);

  // GREATEST/LEAST in Postgres ignore NULL arguments rather than propagating
  // them (the opposite of what you'd guess) — for a LEFT JOIN row with no
  // match, sti.started_at/ended_at are NULL, which would silently collapse
  // GREATEST(NULL, $1)/LEAST(NULL, $2) down to just $1/$2 and compute the
  // ENTIRE window as "active" for every student with zero real intervals.
  // FILTER (WHERE sti.id IS NOT NULL) keeps the sum scoped to genuine rows.
  const { rows } = await pool.query(
    `SELECT
       u.id, u.full_name, u.email, u.google_ou,
       COALESCE(SUM(
         EXTRACT(EPOCH FROM (LEAST(COALESCE(sti.ended_at, NOW()), $2) - GREATEST(sti.started_at, $1)))
       ) FILTER (WHERE sti.id IS NOT NULL), 0)::int AS active_seconds,
       COUNT(DISTINCT sti.device_id) AS device_count
     FROM users u
     LEFT JOIN screen_time_intervals sti
       ON sti.student_id = u.id
       AND sti.started_at < $2
       AND COALESCE(sti.ended_at, NOW()) > $1
     WHERE u.role = 'student' AND u.is_active = true
       ${rosterClause}
     GROUP BY u.id
     HAVING COALESCE(SUM(
         EXTRACT(EPOCH FROM (LEAST(COALESCE(sti.ended_at, NOW()), $2) - GREATEST(sti.started_at, $1)))
       ) FILTER (WHERE sti.id IS NOT NULL), 0) > 0
     ORDER BY active_seconds DESC
     LIMIT $3 OFFSET $4`,
    params
  );

  res.json({ from, to, students: rows });
});

// ---------------------------------------------------------------------------
// GET /api/v1/screen-time/daily?student_id=&from=&to=
// Per-day active-minute breakdown for one student (chart/drill-down).
// Buckets by the interval's start day — a interval spanning midnight is
// attributed to its start day; negligible in practice since idle/lock
// almost always closes a session out well before then in a school setting.
// ---------------------------------------------------------------------------
router.get('/daily', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { student_id } = req.query;
  if (!student_id) return res.status(400).json({ error: 'student_id is required' });

  if (req.user.role === 'teacher' && !(await teacherOwnsStudent(req.user.userId, student_id))) {
    return res.status(403).json({ error: 'This student is not on one of your rosters' });
  }

  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400_000);
  const to   = req.query.to   ? new Date(req.query.to)   : new Date();

  const { rows } = await pool.query(
    `SELECT
       date_trunc('day', started_at) AS day,
       SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at)))::int AS active_seconds
     FROM screen_time_intervals
     WHERE student_id = $1 AND started_at >= $2 AND started_at < $3
     GROUP BY day
     ORDER BY day`,
    [student_id, from, to]
  );

  res.json({ student_id, from, to, days: rows });
});

module.exports = router;
