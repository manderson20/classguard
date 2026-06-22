const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const { pool } = require('../db');
const redis    = require('../redis');
const { authenticate }   = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const adminAuth = [authenticate, requirePermission('unblock_requests')];

// Category slugs where is_blocked_default = TRUE — override codes are forbidden for these.
// Mirrors the seeded rows in migration 018.
const CIPA_SLUGS = new Set([
  'adult', 'violence', 'weapons', 'gambling',
  'drugs_alcohol', 'hate_speech', 'phishing', 'malware',
]);

// Generates a human-readable 8-char alphanumeric code (no confusable chars 0/O/1/I/L).
function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8), b => chars[b % chars.length]).join('');
}

// Redis key for active override: classguard:override:{ip}:{domain}
// Set when an override code is successfully verified.
const overrideKey = (ip, domain) => `classguard:override:${ip}:${domain}`;

// ---------------------------------------------------------------------------
// POST /api/v1/override-codes  — admin generates a code
// ---------------------------------------------------------------------------
router.post('/', ...adminAuth, async (req, res) => {
  const { domain, duration_hours = 4, notes, unblock_request_id, target_student_id } = req.body;

  if (!domain) return res.status(400).json({ error: 'domain is required' });

  // CIPA check: refuse to generate codes for CIPA-floor categories
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM domain_categories dc
       JOIN website_categories wc ON wc.id = dc.category_id
       WHERE dc.domain = $1 AND wc.slug = ANY($2::text[])
       LIMIT 1`,
      [domain.toLowerCase(), [...CIPA_SLUGS]]
    );
    if (rows.length > 0) {
      return res.status(403).json({
        error: 'Override codes cannot be generated for CIPA-protected content. ' +
               'This domain must be reviewed and explicitly allowed by IT administration.',
      });
    }
  } catch (err) {
    console.error('[override-codes] CIPA check error:', err);
  }

  const hours   = Math.min(Math.max(parseFloat(duration_hours) || 4, 0.25), 72);
  const expires = new Date(Date.now() + hours * 3_600_000);

  // Retry if code collides (extremely unlikely)
  let code, inserted;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateCode();
    try {
      const { rows: [row] } = await pool.query(
        `INSERT INTO override_codes
           (code, domain, generated_by, expires_at, notes, unblock_request_id, target_student_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [code, domain.toLowerCase(), req.user.userId, expires, notes || null,
         unblock_request_id || null, target_student_id || null]
      );
      inserted = row;
      break;
    } catch (err) {
      if (err.code !== '23505') throw err; // re-throw non-duplicate errors
    }
  }

  if (!inserted) return res.status(500).json({ error: 'Failed to generate a unique code' });

  // If linked to an unblock request, mark it approved
  if (unblock_request_id) {
    await pool.query(
      `UPDATE unblock_requests
         SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(),
             review_note = 'Approved with temporary override code'
       WHERE id = $2`,
      [req.user.userId, unblock_request_id]
    ).catch(() => {});
  }

  res.status(201).json(inserted);
});

// ---------------------------------------------------------------------------
// POST /api/v1/override-codes/verify  — student submits a code from block page
// Unauthenticated endpoint — the source IP is the identifier for DNS override.
// ---------------------------------------------------------------------------
router.post('/verify', async (req, res) => {
  const { code, domain } = req.body;
  if (!code || !domain) return res.status(400).json({ error: 'code and domain are required' });

  const sourceIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  // Try to get student identity from JWT if present
  let studentId = null;
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      studentId = payload.userId || null;
    }
  } catch {}

  try {
    const { rows: [codeRow] } = await pool.query(
      `SELECT * FROM override_codes
       WHERE code = $1
         AND LOWER(domain) = LOWER($2)
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [code.toUpperCase().trim(), domain.toLowerCase()]
    );

    if (!codeRow) {
      return res.status(404).json({ valid: false, error: 'Invalid or expired code' });
    }

    // If code is restricted to a specific student, verify identity
    if (codeRow.target_student_id && studentId && codeRow.target_student_id !== studentId) {
      return res.status(403).json({ valid: false, error: 'This code is not valid for your account' });
    }

    // Mark as used
    await pool.query(
      `UPDATE override_codes
         SET used_at = NOW(), used_by_ip = $1, used_by_student = $2
       WHERE id = $3`,
      [sourceIp || null, studentId || null, codeRow.id]
    );

    // Store Redis override so DNS engine allows this domain for this IP
    const ttlSeconds = Math.max(1, Math.floor((new Date(codeRow.expires_at) - Date.now()) / 1000));
    if (sourceIp) {
      await redis.set(overrideKey(sourceIp, domain.toLowerCase()), '1', 'EX', ttlSeconds);
    }

    res.json({
      valid:      true,
      domain:     codeRow.domain,
      expires_at: codeRow.expires_at,
    });
  } catch (err) {
    console.error('[override-codes] verify error:', err);
    res.status(500).json({ valid: false, error: 'Verification failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/override-codes  — admin list
// ---------------------------------------------------------------------------
router.get('/', ...adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT oc.*,
            u.full_name AS generated_by_name,
            s.full_name AS target_student_name
     FROM override_codes oc
     JOIN users u ON u.id = oc.generated_by
     LEFT JOIN users s ON s.id = oc.target_student_id
     ORDER BY oc.generated_at DESC
     LIMIT 100`
  );
  res.json(rows);
});

module.exports = router;
