const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

// Authenticated admin middleware
const adminAuth = [authenticate, requirePermission('unblock_requests')];

// ---------------------------------------------------------------------------
// POST /api/v1/unblock-requests
// Submit a request to unblock a domain. Accepts both authenticated requests
// (from the extension, with a student JWT) and unauthenticated (from the DNS
// block page, with email + name as identifier).
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { domain, reason, requester_email, requester_name } = req.body;

  if (!domain || domain.length > 255) {
    return res.status(400).json({ error: 'domain is required' });
  }

  // Try to parse JWT if present (extension requests)
  let studentId = null;
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      studentId = payload.userId || null;
    }
  } catch {}

  // Check who is allowed to submit requests
  const { rows: [settingRow] } = await pool.query(
    `SELECT value FROM settings WHERE key = 'unblock_requests_who'`
  );
  const who = settingRow?.value || 'all';
  if (who === 'off') {
    return res.status(403).json({ error: 'Unblock requests are not enabled' });
  }

  // For staff-only mode, check role
  if (who === 'staff' && studentId) {
    const { rows: [user] } = await pool.query(
      `SELECT role FROM users WHERE id = $1`, [studentId]
    );
    if (!user || !['teacher', 'admin', 'superadmin'].includes(user.role)) {
      return res.status(403).json({ error: 'Only staff members can submit unblock requests' });
    }
  }

  // For unauthenticated requests, email is required
  if (!studentId && !requester_email) {
    return res.status(400).json({ error: 'requester_email is required for anonymous requests' });
  }

  const sourceIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  try {
    const { rows: [request] } = await pool.query(
      `INSERT INTO unblock_requests
         (domain, student_id, requester_email, requester_name, reason, source_ip)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, domain, status, requested_at`,
      [
        domain.toLowerCase().trim(),
        studentId || null,
        requester_email?.toLowerCase().trim() || null,
        requester_name?.trim() || null,
        reason?.trim() || null,
        sourceIp || null,
      ]
    );
    res.status(201).json(request);
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(409).json({ error: 'You already have a pending request for this domain' });
    }
    console.error('[unblock-requests] POST error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/unblock-requests  — admin list with optional status filter
// ---------------------------------------------------------------------------
router.get('/', ...adminAuth, async (req, res) => {
  const status = req.query.status;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  try {
    const { rows } = await pool.query(
      `SELECT
         ur.*,
         u.full_name  AS student_name,
         u.email      AS student_email,
         u.google_ou  AS student_ou,
         r.full_name  AS reviewer_name
       FROM unblock_requests ur
       LEFT JOIN users u ON u.id = ur.student_id
       LEFT JOIN users r ON r.id = ur.reviewed_by
       ${status ? 'WHERE ur.status = $3' : ''}
       ORDER BY
         CASE ur.status WHEN 'pending' THEN 0 ELSE 1 END,
         ur.requested_at DESC
       LIMIT $1 OFFSET $2`,
      status ? [limit, offset, status] : [limit, offset]
    );

    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM unblock_requests ${status ? 'WHERE status = $1' : ''}`,
      status ? [status] : []
    );

    res.json({ requests: rows, total: parseInt(count) });
  } catch (err) {
    console.error('[unblock-requests] GET error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/unblock-requests/pending-count — badge count for nav
// ---------------------------------------------------------------------------
router.get('/pending-count', ...adminAuth, async (req, res) => {
  try {
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM unblock_requests WHERE status = 'pending'`
    );
    res.json({ count: parseInt(count) });
  } catch {
    res.json({ count: 0 });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/unblock-requests/:id  — approve or deny
// ---------------------------------------------------------------------------
router.patch('/:id', ...adminAuth, async (req, res) => {
  const { status, review_note } = req.body;
  if (!['approved', 'denied'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved or denied' });
  }

  try {
    const { rows: [request] } = await pool.query(
      `UPDATE unblock_requests
         SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_note = $3
       WHERE id = $4
       RETURNING *`,
      [status, req.user.userId, review_note || null, req.params.id]
    );
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(request);
  } catch (err) {
    console.error('[unblock-requests] PATCH error:', err);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

module.exports = router;
