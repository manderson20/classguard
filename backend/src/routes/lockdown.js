const { Router } = require('express');
const { query, withTransaction } = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { invalidatePolicy } = require('../services/policyResolver');
const { teacherOwnsStudent } = require('../services/teacherRoster');
const events = require('../events');

const router = Router();
router.use(authenticate, requireMinRole('teacher'));

// Lockdown Browser for tests — a teacher-initiated, single-URL browser lock
// (e.g. a Google Form), distinct from lesson_sessions' multi-domain
// whitelist. This is a SOFT lock: a Chrome extension can't block OS-level
// app switching, only tab/window behavior within Chrome itself — see
// rules.js and the extension's service worker for enforcement.

// GET /api/v1/lockdown/active
// District-wide list of every currently active session — the admin
// "is anyone stuck in a locked test, and can I get them out" view.
// Teachers see only their own; admins see everyone.
router.get('/active', async (req, res) => {
  const { role, userId } = req.user;

  let sql = `
    SELECT ls.*, u.full_name AS student_name, u.email AS student_email,
           t.full_name AS teacher_name,
           (SELECT COUNT(*) FROM lockdown_events le WHERE le.lockdown_session_id = ls.id) AS event_count
    FROM lockdown_sessions ls
    JOIN users u ON u.id = ls.student_id
    JOIN users t ON t.id = ls.teacher_id
    WHERE ls.status = 'active'
  `;
  const values = [];
  if (role === 'teacher') {
    sql += ` AND ls.teacher_id = $1`;
    values.push(userId);
  }
  sql += ' ORDER BY ls.started_at DESC';

  const { rows } = await query(sql, values);
  res.json(rows);
});

// GET /api/v1/lockdown/:id/events — escape-attempt feed for one session
router.get('/:id/events', async (req, res) => {
  const { rows: sessionRows } = await query('SELECT teacher_id FROM lockdown_sessions WHERE id = $1', [req.params.id]);
  if (!sessionRows[0]) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role === 'teacher' && sessionRows[0].teacher_id !== req.user.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { rows } = await query(
    `SELECT * FROM lockdown_events WHERE lockdown_session_id = $1 ORDER BY occurred_at DESC LIMIT 200`,
    [req.params.id]
  );
  res.json(rows);
});

// POST /api/v1/lockdown
// body: { student_ids: [...], class_id?, target_url, duration_minutes? }
// Starts (or replaces) a lockdown session for each student. Any prior
// active session for a given student is closed first — one active lockdown
// per student at a time.
router.post('/', async (req, res) => {
  const { role, userId } = req.user;
  const { student_ids = [], class_id = null, target_url, duration_minutes } = req.body;

  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return res.status(400).json({ error: 'student_ids is required' });
  }
  if (!target_url || !/^https?:\/\//i.test(target_url)) {
    return res.status(400).json({ error: 'target_url must be a full http(s) URL' });
  }

  if (role === 'teacher') {
    for (const sid of student_ids) {
      if (!(await teacherOwnsStudent(userId, sid))) {
        return res.status(403).json({ error: 'One or more students are not on one of your rosters' });
      }
    }
  }

  const endsAt = duration_minutes ? new Date(Date.now() + duration_minutes * 60_000) : null;

  const sessions = await withTransaction(async (client) => {
    const created = [];
    for (const studentId of student_ids) {
      await client.query(
        `UPDATE lockdown_sessions SET status = 'ended', ended_at = NOW(), ended_by = $1
         WHERE student_id = $2 AND status = 'active'`,
        [userId, studentId]
      );
      const { rows } = await client.query(
        `INSERT INTO lockdown_sessions (student_id, teacher_id, class_id, target_url, ends_at)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [studentId, userId, class_id, target_url, endsAt]
      );
      created.push(rows[0]);
    }
    return created;
  });

  for (const session of sessions) {
    await invalidatePolicy(session.student_id);
    events.emit('policy:updated', { studentId: session.student_id });
  }

  res.status(201).json(sessions);
});

// DELETE /api/v1/lockdown/:id — end a session (teacher who owns it, or admin)
router.delete('/:id', async (req, res) => {
  const { role, userId } = req.user;
  const { rows: existing } = await query('SELECT * FROM lockdown_sessions WHERE id = $1 AND status = $2', [req.params.id, 'active']);
  if (!existing[0]) return res.status(404).json({ error: 'Active session not found' });
  if (role === 'teacher' && existing[0].teacher_id !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { rows } = await query(
    `UPDATE lockdown_sessions SET status = 'ended', ended_at = NOW(), ended_by = $1
     WHERE id = $2 RETURNING *`,
    [userId, req.params.id]
  );

  await invalidatePolicy(rows[0].student_id);
  events.emit('policy:updated', { studentId: rows[0].student_id });

  res.json(rows[0]);
});

module.exports = router;
