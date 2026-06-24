const { pool } = require('../db');

// Reconciles student device activity against each teacher's SCHEDULED
// periods (bell_schedule_periods x classes.period x class_members), entirely
// independent of whether a lesson_session was ever started — that's the
// whole point: measuring actual usage during the period a teacher was
// supposed to be teaching, not just when they explicitly flagged a lesson.
//
// Computed as a nightly batch into teacher_period_utilization rather than
// queried live — reconciling this for an entire district on every page
// load would be expensive, and the data doesn't need to be real-time.
async function computeTeacherUtilization(fromDate, toDate) {
  // GREATEST/LEAST in Postgres ignore NULL arguments instead of
  // propagating them — same pitfall as screenTime.js's summary query. A
  // LEFT JOIN with no matching interval must be explicitly zeroed via the
  // CASE, or every enrolled student with literally no device activity
  // would otherwise be counted as active for the period's ENTIRE duration.
  await pool.query(
    `
    WITH dates AS (
      SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS school_date
    ),
    -- Which bell schedule a given student follows -- district picks
    -- exactly one matching strategy (OU prefix vs exact grade_level),
    -- never both at once, falling back to the default schedule. Mirrors
    -- policyResolver.js's OU longest-prefix-match pattern.
    match_mode AS (
      SELECT COALESCE((SELECT value FROM settings WHERE key = 'bell_schedule_match_mode'), 'grade_level') AS mode
    ),
    default_schedule AS (
      SELECT id FROM bell_schedules WHERE is_default = true LIMIT 1
    ),
    student_schedule AS (
      SELECT u.id AS student_id,
        COALESCE(
          CASE WHEN mm.mode = 'ou' THEN (
            SELECT ba.schedule_id FROM bell_schedule_assignments ba
            WHERE ba.target_type = 'ou' AND u.google_ou LIKE ba.target_ou || '%'
            ORDER BY LENGTH(ba.target_ou) DESC LIMIT 1
          ) END,
          CASE WHEN mm.mode = 'grade_level' THEN (
            SELECT ba.schedule_id FROM bell_schedule_assignments ba
            WHERE ba.target_type = 'grade_level' AND ba.target_grade_level = u.grade_level
            LIMIT 1
          ) END,
          (SELECT id FROM default_schedule)
        ) AS schedule_id
      FROM users u, match_mode mm
      WHERE u.role = 'student'
    ),
    -- Per (class, enrolled student, day) rather than per class -- two
    -- students in the same class can be on different bell schedules (e.g.
    -- a mixed-grade elective spanning a Middle School's two schedules),
    -- so each student's own resolved schedule decides their period window.
    period_windows AS (
      SELECT
        c.id AS class_id, c.teacher_id, c.period AS period_label, cm.student_id, d.school_date,
        (d.school_date + bsp.start_time) AS window_start,
        (d.school_date + bsp.end_time)   AS window_end,
        EXTRACT(EPOCH FROM (bsp.end_time - bsp.start_time))::int AS period_seconds
      FROM classes c
      JOIN class_members cm   ON cm.class_id = c.id
      JOIN student_schedule ss ON ss.student_id = cm.student_id
      JOIN bell_schedule_periods bsp ON bsp.schedule_id = ss.schedule_id AND bsp.period_label = c.period
      CROSS JOIN dates d
      WHERE EXTRACT(DOW FROM d.school_date)::int = ANY(bsp.days_of_week)
        AND c.is_active = true
        AND c.teacher_id IS NOT NULL
    ),
    overlap_rows AS (
      SELECT
        e.class_id, e.teacher_id, e.period_label, e.school_date, e.period_seconds, e.student_id,
        CASE WHEN sti.id IS NULL THEN 0 ELSE
          GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(COALESCE(sti.ended_at, NOW()), e.window_end) - GREATEST(sti.started_at, e.window_start)
          )))
        END AS overlap_seconds
      FROM period_windows e
      LEFT JOIN screen_time_intervals sti
        ON sti.student_id = e.student_id
        AND sti.started_at < e.window_end
        AND COALESCE(sti.ended_at, NOW()) > e.window_start
    )
    INSERT INTO teacher_period_utilization
      (teacher_id, class_id, period_label, school_date, enrolled_count, active_student_count, active_student_seconds, period_seconds, computed_at)
    SELECT
      teacher_id, class_id, period_label, school_date,
      COUNT(DISTINCT student_id) AS enrolled_count,
      COUNT(DISTINCT student_id) FILTER (WHERE overlap_seconds > 0) AS active_student_count,
      COALESCE(SUM(overlap_seconds), 0)::bigint AS active_student_seconds,
      -- This table's grain is still (class, period, day) -- if a single
      -- class enrolls students from two different bell schedules with
      -- different period durations (rare: schedule assignment is by OU or
      -- grade level, which naturally clusters students who take classes
      -- together), MAX() picks one arbitrarily as "the" duration for the
      -- whole class rather than splitting the row per schedule. Accepted
      -- as a known approximation for now rather than widening this table's
      -- grain to (class, period, day, schedule) for an edge case.
      MAX(period_seconds) AS period_seconds,
      NOW()
    FROM overlap_rows
    GROUP BY class_id, teacher_id, period_label, school_date
    ON CONFLICT (class_id, period_label, school_date) DO UPDATE SET
      teacher_id             = EXCLUDED.teacher_id,
      enrolled_count          = EXCLUDED.enrolled_count,
      active_student_count    = EXCLUDED.active_student_count,
      active_student_seconds  = EXCLUDED.active_student_seconds,
      period_seconds          = EXCLUDED.period_seconds,
      computed_at             = NOW()
    `,
    [fromDate, toDate]
  );
}

// Nightly run covers a rolling lookback window — not just "yesterday" —
// so a late-arriving heartbeat/interval close (e.g. a device that was
// asleep and only reported back hours later) still gets folded into the
// correct day's numbers on the next run instead of being permanently missed.
async function runNightly() {
  const to   = new Date();
  const from = new Date(to.getTime() - 7 * 86400_000);
  await computeTeacherUtilization(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
}

module.exports = { computeTeacherUtilization, runNightly };
