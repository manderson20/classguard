const { Router } = require('express');
const { pool }   = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const teacherUtilization = require('../services/teacherUtilization');

const router = Router();

// GET /api/v1/analytics/staff
// Returns teacher usage stats for the Staff Analytics admin page.
router.get('/staff', authenticate, requirePermission('staff_analytics'), async (req, res) => {
  const { rows: teachers } = await pool.query(`
    SELECT
      u.id,
      u.full_name,
      u.email,
      u.photo_url,
      u.google_ou,
      u.last_login_at,

      -- number of classes this teacher owns
      COUNT(DISTINCT c.id)::int                              AS class_count,

      -- total students across all their classes
      COUNT(DISTINCT cm.student_id)::int                     AS student_count,

      -- lessons started in the last 30 days
      COUNT(DISTINCT l.id) FILTER (
        WHERE l.started_at >= NOW() - INTERVAL '30 days'
      )::int                                                 AS lessons_30d,

      -- penalty box actions placed by this teacher in last 30 days
      COUNT(DISTINCT pb.id) FILTER (
        WHERE pb.placed_at >= NOW() - INTERVAL '30 days'
      )::int                                                 AS penalty_actions_30d

    FROM users u
    LEFT JOIN classes     c  ON c.teacher_id = u.id
    LEFT JOIN class_members cm ON cm.class_id = c.id
    LEFT JOIN lesson_sessions l ON l.class_id = c.id
    LEFT JOIN penalty_box pb ON pb.placed_by = u.id

    WHERE u.role IN ('teacher','admin','superadmin')
      AND u.is_active = true

    GROUP BY u.id
    ORDER BY u.last_login_at DESC NULLS LAST
  `);

  // Summary row
  const total      = teachers.length;
  const weekAgo    = Date.now() - 7 * 86400_000;
  const activeWeek = teachers.filter(t => t.last_login_at && new Date(t.last_login_at) > weekAgo).length;
  const totalLessons = teachers.reduce((s, t) => s + (t.lessons_30d ?? 0), 0);
  const totalStudents = teachers.reduce((s, t) => s + (t.student_count ?? 0), 0);
  const avgClass   = total > 0 ? Math.round(totalStudents / total) : 0;

  res.json({
    summary: {
      total_teachers:    total,
      active_this_week:  activeWeek,
      total_lessons_30d: totalLessons,
      avg_class_size:    avgClass,
    },
    teachers,
  });
});

// GET /api/v1/analytics/staff/utilization?from=&to=
// Per-teacher rollup of teacher_period_utilization (built nightly by
// teacherUtilization.js): how much of each scheduled period's time was
// actually spent active on a device, across all that teacher's classes —
// independent of whether a lesson_session was ever started.
router.get('/staff/utilization', authenticate, requirePermission('staff_analytics'), async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const to   = req.query.to   || new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT
       u.id, u.full_name, u.email,
       SUM(tpu.enrolled_count)::int          AS scheduled_student_periods,
       SUM(tpu.active_student_count)::int    AS active_student_periods,
       SUM(tpu.active_student_seconds)::bigint AS active_student_seconds,
       SUM(tpu.enrolled_count * tpu.period_seconds)::bigint AS possible_student_seconds
     FROM teacher_period_utilization tpu
     JOIN users u ON u.id = tpu.teacher_id
     WHERE tpu.school_date >= $1 AND tpu.school_date <= $2
     GROUP BY u.id
     ORDER BY active_student_seconds DESC`,
    [from, to]
  );

  res.json({ from, to, teachers: rows });
});

// POST /api/v1/analytics/staff/utilization/recompute
// Manual trigger for the nightly reconciliation job — useful right after
// configuring the bell schedule, instead of waiting for 4:30am.
router.post('/staff/utilization/recompute', authenticate, requirePermission('staff_analytics'), async (req, res) => {
  const from = req.body.from || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const to   = req.body.to   || new Date().toISOString().slice(0, 10);
  await teacherUtilization.computeTeacherUtilization(from, to);
  res.json({ ok: true, from, to });
});

module.exports = router;
