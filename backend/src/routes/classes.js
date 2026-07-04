const { Router } = require('express');
const { query, withTransaction } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermissionIfAdmin } = require('../middleware/permissions');
const { invalidatePoliciesForClass } = require('../services/policyResolver');
const events = require('../events');

const router = Router();

router.use(authenticate, requireMinRole('teacher'));

// GET /api/v1/classes
router.get('/', async (req, res) => {
  const { role, userId } = req.user;
  const adminPlus = ['admin','superadmin'].includes(role);

  const { rows } = await query(
    `SELECT c.*, u.full_name AS teacher_name,
            COUNT(cm.student_id) AS student_count
     FROM classes c
     JOIN users u ON u.id = c.teacher_id
     LEFT JOIN class_members cm ON cm.class_id = c.id
     WHERE ($1 OR c.teacher_id = $2)
     GROUP BY c.id, u.full_name
     ORDER BY c.name`,
    [adminPlus, userId]
  );
  res.json(rows);
});

// GET /api/v1/classes/:id
router.get('/:id', async (req, res) => {
  const { role, userId } = req.user;
  const { rows } = await query(
    `SELECT c.*, u.full_name AS teacher_name
     FROM classes c
     JOIN users u ON u.id = c.teacher_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Class not found' });
  if (role === 'teacher' && rows[0].teacher_id !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { rows: members } = await query(
    `SELECT u.id, u.full_name, u.given_name, u.email, u.google_ou, u.photo_url
     FROM class_members cm
     JOIN users u ON u.id = cm.student_id
     WHERE cm.class_id = $1
     ORDER BY u.full_name`,
    [req.params.id]
  );

  const { rows: activeLesson } = await query(
    `SELECT * FROM lesson_sessions WHERE class_id = $1 AND is_active = true LIMIT 1`,
    [req.params.id]
  );

  res.json({ ...rows[0], members, active_lesson: activeLesson[0] || null });
});

// POST /api/v1/classes
router.post('/', requireMinRole('admin'), requirePermissionIfAdmin('classes'), async (req, res) => {
  const { name, teacher_id, google_classroom_id = null } = req.body;
  if (!name || !teacher_id) return res.status(400).json({ error: 'name and teacher_id required' });

  const { rows } = await query(
    `INSERT INTO classes (name, teacher_id, google_classroom_id)
     VALUES ($1,$2,$3) RETURNING *`,
    [name, teacher_id, google_classroom_id]
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/v1/classes/:id
router.patch('/:id', requireMinRole('admin'), requirePermissionIfAdmin('classes'), async (req, res) => {
  const allowed = ['name','teacher_id'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (fields.length === 0) return res.status(400).json({ error: 'No updatable fields' });

  // classes has no updated_at column (unlike most other tables in this
  // schema) -- found live 2026-07-01: this route 500'd on every real call,
  // "column updated_at of relation classes does not exist", since it was
  // apparently never actually exercised before.
  const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map(f => req.body[f]);
  const { rows } = await query(
    `UPDATE classes SET ${sets} WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Class not found' });
  res.json(rows[0]);
});

// DELETE /api/v1/classes/:id
router.delete('/:id', requireMinRole('admin'), requirePermissionIfAdmin('classes'), async (req, res) => {
  const { rows } = await query('DELETE FROM classes WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Class not found' });
  res.json({ deleted: rows[0].id });
});

// PATCH /api/v1/classes/:id/auto-start  body: { auto_start_lessons }
// Teacher-facing (unlike the general PATCH /:id above, which is
// admin-only) -- toggles whether services/scheduler.js's per-minute
// bell-schedule cron auto-starts a lesson_sessions row for this class when
// its matching bell_schedule_periods window begins. Owning teacher or
// admin only. A teacher manually starting a lesson (POST /:id/lessons,
// whenever that happens to be) always takes precedence -- the cron only
// ever creates a session if this class doesn't already have an active one,
// so an early/late manual start is never overridden or duplicated.
router.patch('/:id/auto-start', async (req, res) => {
  const { auto_start_lessons } = req.body;
  if (typeof auto_start_lessons !== 'boolean') {
    return res.status(400).json({ error: 'auto_start_lessons (boolean) required' });
  }
  const { rows: [cls] } = await query('SELECT teacher_id FROM classes WHERE id = $1', [req.params.id]);
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  if (req.user.role === 'teacher' && cls.teacher_id !== req.user.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { rows } = await query(
    'UPDATE classes SET auto_start_lessons = $1 WHERE id = $2 RETURNING *',
    [auto_start_lessons, req.params.id]
  );
  res.json(rows[0]);
});

// POST /api/v1/classes/:id/members  body: { user_id }
router.post('/:id/members', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  await query(
    'INSERT INTO class_members (class_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.params.id, user_id]
  );
  res.status(201).json({ class_id: req.params.id, user_id });
});

// DELETE /api/v1/classes/:id/members/:userId
router.delete('/:id/members/:userId', async (req, res) => {
  await query(
    'DELETE FROM class_members WHERE class_id = $1 AND student_id = $2',
    [req.params.id, req.params.userId]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Lesson sessions — teacher controls
// ---------------------------------------------------------------------------

// GET /api/v1/classes/:id/lessons  — past lesson sessions for this class
// (Teacher Live View Phase 4 — "teacher's own history page"). Basic summary
// only: participant/activity/blocked counts come from browser_history's
// lesson_session_id tag (Phase 3) — no new join against teacher_actions/
// chat_threads/lockdown_sessions, which aren't lesson-session-tagged today.
router.get('/:id/lessons', async (req, res) => {
  const { role, userId } = req.user;
  const classId = req.params.id;
  const page  = Math.max(parseInt(req.query.page, 10)  || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = (page - 1) * limit;

  const { rows: cls } = await query('SELECT teacher_id FROM classes WHERE id = $1', [classId]);
  if (!cls[0]) return res.status(404).json({ error: 'Class not found' });
  if (role === 'teacher' && cls[0].teacher_id !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const [{ rows: lessons }, { rows: countRow }] = await Promise.all([
    query(
      `SELECT ls.*,
              (SELECT COUNT(DISTINCT user_id) FROM browser_history WHERE lesson_session_id = ls.id) AS participant_count,
              (SELECT COUNT(*) FROM browser_history WHERE lesson_session_id = ls.id) AS activity_count,
              (SELECT COUNT(*) FROM browser_history WHERE lesson_session_id = ls.id AND action = 'blocked') AS blocked_count
       FROM lesson_sessions ls
       WHERE ls.class_id = $1
       ORDER BY ls.started_at DESC
       LIMIT $2 OFFSET $3`,
      [classId, limit, offset]
    ),
    query('SELECT COUNT(*) AS total FROM lesson_sessions WHERE class_id = $1', [classId]),
  ]);

  res.json({
    total:   parseInt(countRow[0].total, 10),
    page,
    limit,
    results: lessons,
  });
});

// POST /api/v1/classes/:id/lessons  — start a lesson
router.post('/:id/lessons', async (req, res) => {
  const { role, userId } = req.user;
  const classId = req.params.id;

  // Verify ownership
  const { rows: cls } = await query('SELECT teacher_id FROM classes WHERE id = $1', [classId]);
  if (!cls[0]) return res.status(404).json({ error: 'Class not found' });
  if (role === 'teacher' && cls[0].teacher_id !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { allowed_domains = [], name = null } = req.body;

  const lesson = await withTransaction(async (client) => {
    // Close any existing active session for this class
    await client.query(
      `UPDATE lesson_sessions SET is_active = false, ended_at = NOW()
       WHERE class_id = $1 AND is_active = true`,
      [classId]
    );
    const { rows } = await client.query(
      `INSERT INTO lesson_sessions (class_id, teacher_id, name, allowed_domains, is_active)
       VALUES ($1,$2,$3,$4,true)
       RETURNING *`,
      [classId, userId, name, JSON.stringify(allowed_domains)]
    );
    return rows[0];
  });

  // Bust policy cache so DNS engine picks up the lesson override
  const studentIds = await invalidatePoliciesForClass(classId);
  for (const sid of studentIds) {
    events.emit('policy:updated', { studentId: sid });
  }

  res.status(201).json(lesson);
});

// PATCH /api/v1/classes/:id/lessons/:lessonId  — update allowed domains mid-lesson
router.patch('/:id/lessons/:lessonId', async (req, res) => {
  const { role, userId } = req.user;
  const { rows: cls } = await query('SELECT teacher_id FROM classes WHERE id = $1', [req.params.id]);
  if (!cls[0]) return res.status(404).json({ error: 'Class not found' });
  if (role === 'teacher' && cls[0].teacher_id !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { allowed_domains } = req.body;
  const { rows } = await query(
    `UPDATE lesson_sessions
     SET allowed_domains = $1, updated_at = NOW()
     WHERE id = $2 AND class_id = $3 AND is_active = true
     RETURNING *`,
    [JSON.stringify(allowed_domains || []), req.params.lessonId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Active lesson not found' });

  const studentIds = await invalidatePoliciesForClass(req.params.id);
  for (const sid of studentIds) {
    events.emit('policy:updated', { studentId: sid });
  }

  res.json(rows[0]);
});

// DELETE /api/v1/classes/:id/lessons/:lessonId  — end a lesson
router.delete('/:id/lessons/:lessonId', async (req, res) => {
  const { role, userId } = req.user;
  const { rows: cls } = await query('SELECT teacher_id FROM classes WHERE id = $1', [req.params.id]);
  if (!cls[0]) return res.status(404).json({ error: 'Class not found' });
  if (role === 'teacher' && cls[0].teacher_id !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { rows } = await query(
    `UPDATE lesson_sessions
     SET is_active = false, ended_at = NOW()
     WHERE id = $1 AND class_id = $2
     RETURNING *`,
    [req.params.lessonId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Lesson not found' });

  const studentIds = await invalidatePoliciesForClass(req.params.id);
  for (const sid of studentIds) {
    events.emit('policy:updated', { studentId: sid });
    // A lock is a deliberate, temporary state for this lesson — don't leave
    // a student locked out of their own browser once the period has ended.
    events.emit('teacher:unlock_request', { studentId: sid });
  }

  res.json(rows[0]);
});

// POST /api/v1/classes/:id/sync-roster  — stub for Phase 8 Google Classroom sync
router.post('/:id/sync-roster', async (req, res) => {
  res.status(501).json({ error: 'Google Classroom roster sync — Phase 8' });
});

module.exports = router;
