// Lets an admin temporarily view ClassGuard exactly as a specific teacher
// would, to troubleshoot on their behalf without needing their password.
// The minted token carries the teacher's real userId/role (so every
// existing teacher-scoped route -- classes.js, penaltyBox.js, lockdown.js,
// etc. -- just works unmodified, filtering by teacher_id the same as a
// real teacher login would) plus an impersonatedBy claim identifying the
// real admin, which is what makes this auditable rather than a silent
// identity swap. See impersonation_audit (migration 069) and
// middleware/impersonationAudit.js, which logs every mutating request
// made while impersonatedBy is set.
const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const config  = require('../config');
const { query, pool } = require('../db');
const { authenticate }      = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

// Deliberately much shorter than the normal 8h session (config.jwt.expiresIn)
// -- this is a "look over the shoulder" tool, not a second standing login,
// and /auth/refresh explicitly refuses to extend it (see routes/auth.js).
const IMPERSONATION_TTL = '30m';

router.post('/:teacherId/start', authenticate, requirePermission('impersonate_users'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, email, full_name, role, is_active FROM users WHERE id = $1`,
      [req.params.teacherId]
    );
    const teacher = rows[0];
    if (!teacher) return res.status(404).json({ error: 'User not found' });
    // Restricted to teacher accounts specifically -- impersonating another
    // admin/superadmin is a much bigger privilege-escalation surface than
    // "see what a teacher sees", and isn't what was asked for.
    if (teacher.role !== 'teacher') {
      return res.status(400).json({ error: 'Impersonation is only available for teacher accounts' });
    }
    if (!teacher.is_active) {
      return res.status(400).json({ error: 'Cannot impersonate a deactivated account' });
    }

    const { rows: adminRows } = await query('SELECT full_name FROM users WHERE id = $1', [req.user.userId]);
    const adminName = adminRows[0]?.full_name || null;
    const sessionId = crypto.randomUUID();

    const token = jwt.sign(
      {
        userId: teacher.id,
        email:  teacher.email,
        role:   'teacher',
        impersonatedBy:         { id: req.user.userId, email: req.user.email, name: adminName },
        impersonationSessionId: sessionId,
      },
      config.jwt.secret,
      { expiresIn: IMPERSONATION_TTL }
    );

    await pool.query(
      `INSERT INTO impersonation_audit
         (session_id, admin_id, admin_email, admin_name, teacher_id, teacher_email, teacher_name, action, detail, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'started',$8,$9)`,
      [sessionId, req.user.userId, req.user.email, adminName,
       teacher.id, teacher.email, teacher.full_name,
       JSON.stringify({ ttl: IMPERSONATION_TTL }), req.ip]
    );

    res.json({
      token,
      user: {
        id: teacher.id, email: teacher.email, name: teacher.full_name, role: teacher.role,
        impersonatedBy: { id: req.user.userId, email: req.user.email, name: adminName },
        impersonationSessionId: sessionId,
      },
    });
  } catch (err) {
    console.error('[impersonation] start error:', err.message);
    res.status(500).json({ error: 'Failed to start impersonation session' });
  }
});

// Works off the impersonation token itself (no special permission needed --
// anyone holding a token with impersonatedBy set is, by construction, the
// admin who started it) so "exit" never depends on still holding the
// original admin token or any extra round trip.
router.post('/end', authenticate, async (req, res) => {
  if (!req.user.impersonatedBy) {
    return res.status(400).json({ error: 'Not currently impersonating' });
  }
  try {
    await pool.query(
      `INSERT INTO impersonation_audit
         (session_id, admin_id, admin_email, admin_name, teacher_id, teacher_email, action, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,'ended',$7)`,
      [req.user.impersonationSessionId, req.user.impersonatedBy.id, req.user.impersonatedBy.email,
       req.user.impersonatedBy.name, req.user.userId, req.user.email, req.ip]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[impersonation] end error:', err.message);
    res.status(500).json({ error: 'Failed to end impersonation session' });
  }
});

router.get('/audit', authenticate, requirePermission('impersonate_users'), async (req, res) => {
  const { admin_id, teacher_id, action, limit = 100, offset = 0 } = req.query;
  const conditions = [];
  const params = [];
  if (admin_id)   { conditions.push(`admin_id = $${params.length + 1}`);   params.push(admin_id); }
  if (teacher_id) { conditions.push(`teacher_id = $${params.length + 1}`); params.push(teacher_id); }
  if (action)     { conditions.push(`action = $${params.length + 1}`);     params.push(action); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await pool.query(
      `SELECT * FROM impersonation_audit ${where}
       ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM impersonation_audit ${where}`, params
    );
    res.json({ entries: rows, total: parseInt(count, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
