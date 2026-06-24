// Logs every mutating request made while an admin is impersonating a
// teacher, so the audit trail covers not just "who impersonated whom" but
// "what did they actually change" -- without having to instrument every
// individual route. Mounted globally in index.js, after body-parsing.
//
// Uses jwt.decode (unverified) purely to peek at claims for logging --
// the real authenticate middleware further down each router still rejects
// a bad/expired/forged token on its own, so a forged token reaching this
// middleware only risks a garbage log line, never a security bypass.
const jwt    = require('jsonwebtoken');
const { pool } = require('../db');

const MUTATING  = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REDACT_RE = /password|secret|token/i;

function redactBody(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = REDACT_RE.test(k) ? '[redacted]' : v;
  }
  return out;
}

function impersonationAuditLogger(req, res, next) {
  // /impersonation/:id/start and /impersonation/end already write their
  // own 'started'/'ended' rows -- skip those here to avoid double-logging
  // the same request as a generic 'request' row too.
  if (!MUTATING.has(req.method) || req.path.startsWith('/api/v1/impersonation')) {
    return next();
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();

  let decoded;
  try {
    decoded = jwt.decode(header.slice(7));
  } catch {
    return next();
  }
  if (!decoded?.impersonatedBy) return next();

  pool.query(
    `INSERT INTO impersonation_audit
       (session_id, admin_id, admin_email, admin_name, teacher_id, teacher_email, action, method, path, detail, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,'request',$7,$8,$9,$10)`,
    [
      decoded.impersonationSessionId,
      decoded.impersonatedBy.id, decoded.impersonatedBy.email, decoded.impersonatedBy.name,
      decoded.userId, decoded.email,
      req.method, req.originalUrl,
      JSON.stringify(redactBody(req.body)),
      req.ip,
    ]
  ).catch(err => console.error('[impersonationAudit] failed to log request:', err.message));

  next();
}

module.exports = { impersonationAuditLogger };
