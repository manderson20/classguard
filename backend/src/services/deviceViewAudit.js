// Single write path for device_view_audit (see migration 051 for why this
// table is append-only). Every caller that views a student's screenshots
// or live browser feed should go through this, so there's exactly one
// place that can get the "what did we actually log" shape wrong.
//
// Takes IDs only and looks email/full_name up itself, rather than trusting
// callers to pass a consistent shape - the JWT payload (req.user) only
// carries {userId, email, role}, no name, so callers would otherwise have
// to do this same lookup themselves anyway.
const { pool } = require('../db');

async function logDeviceView({ viewerId, studentId, action, detail = null }) {
  const { rows } = await pool.query(
    `SELECT id, email, full_name FROM users WHERE id = ANY($1::uuid[])`,
    [[viewerId, studentId].filter(Boolean)]
  );
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  const viewer  = byId[viewerId]  || { email: 'unknown', full_name: null };
  const student = byId[studentId] || { email: 'unknown', full_name: null };

  await pool.query(
    `INSERT INTO device_view_audit
       (viewer_id, viewer_email, viewer_name, student_id, student_email, student_name, action, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      viewerId || null, viewer.email, viewer.full_name,
      studentId || null, student.email, student.full_name,
      action, detail ? JSON.stringify(detail) : null,
    ]
  );
}

module.exports = { logDeviceView };
