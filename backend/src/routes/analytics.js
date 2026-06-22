const { Router } = require('express');
const { pool }   = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

const router = Router();

// GET /api/v1/analytics/staff
// Returns teacher usage stats for the Staff Analytics admin page.
router.get('/staff', authenticate, requireMinRole('admin'), async (req, res) => {
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

module.exports = router;
