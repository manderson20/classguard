// Backend routes called exclusively by the ClassGuard Chrome extension.

const { Router }          = require('express');
const { OAuth2Client }    = require('google-auth-library');
const jwt                 = require('jsonwebtoken');
const config              = require('../config');
const { query }           = require('../db');
const redis               = require('../redis');
const { authenticate }    = require('../middleware/auth');
const { resolvePolicy }   = require('../services/policyResolver');
const events              = require('../events');

const router     = Router();
const oauthClient = new OAuth2Client(config.google.clientId);

// ---------------------------------------------------------------------------
// POST /api/v1/extension/auth
// Exchange a Google OAuth access token (from chrome.identity.getAuthToken) for
// a ClassGuard JWT.  The extension cannot do a full code-flow OAuth because it
// runs in a service worker; chrome.identity gives us an access token directly.
// ---------------------------------------------------------------------------
router.post('/auth', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'access_token required' });

  let userInfo;
  try {
    const infoRes = await fetch(
      `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${encodeURIComponent(access_token)}`
    );
    if (!infoRes.ok) throw new Error('Google userinfo rejected the token');
    userInfo = await infoRes.json();
  } catch (err) {
    return res.status(401).json({ error: 'Google token validation failed' });
  }

  const { sub: googleId, email, name: fullName, given_name: givenName, picture: photoUrl, hd: hostedDomain } = userInfo;

  if (config.google.workspaceDomain && hostedDomain !== config.google.workspaceDomain) {
    return res.status(403).json({ error: 'Account domain not authorized for this ClassGuard instance' });
  }

  // Upsert user (extension users are always students unless already assigned another role)
  const { rows } = await query(
    `INSERT INTO users (google_id, email, full_name, given_name, photo_url, role, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,'student',NOW())
     ON CONFLICT (google_id) DO UPDATE SET
       email          = EXCLUDED.email,
       full_name      = EXCLUDED.full_name,
       given_name     = EXCLUDED.given_name,
       photo_url      = EXCLUDED.photo_url,
       last_synced_at = NOW(),
       last_login_at  = NOW(),
       updated_at     = NOW()
     RETURNING *`,
    [googleId, email, fullName, givenName, photoUrl]
  );

  const user = rows[0];
  if (!user.is_active) return res.status(403).json({ error: 'Account is deactivated' });

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  return res.json({
    token,
    user: {
      id:       user.id,
      email:    user.email,
      name:     user.full_name,
      role:     user.role,
      photoUrl: user.photo_url,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/register
// Registers the device's IP address → student mapping so the DNS engine can
// look up the student's policy from an IP address.
// ---------------------------------------------------------------------------
router.post('/register', authenticate, async (req, res) => {
  const studentId = req.user.userId;
  const ip        = req.ip || req.socket.remoteAddress;

  // Store in Redis so the DNS engine can find it; TTL = 8h (matches JWT)
  await redis.set(`device:${ip}`, studentId, 'EX', 8 * 60 * 60);

  // Persist to devices table for audit purposes
  await query(
    `INSERT INTO devices (user_id, ip_address, last_seen_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       ip_address   = EXCLUDED.ip_address,
       last_seen_at = NOW()`,
    [studentId, ip]
  ).catch(() => {}); // non-fatal if table schema differs

  res.json({ ok: true, ip });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/heartbeat
// Periodic liveness signal from the extension (~every 30 s).
// Also re-registers the IP → student mapping so it doesn't expire.
// Body: { url?, title?, socket? }
// ---------------------------------------------------------------------------
router.post('/heartbeat', authenticate, async (req, res) => {
  const studentId = req.user.userId;
  const ip        = req.ip || req.socket.remoteAddress;

  // Refresh IP → student mapping
  await redis.set(`device:${ip}`, studentId, 'EX', 8 * 60 * 60);

  // Update last_seen in devices table
  await query(
    `UPDATE devices SET last_seen_at = NOW(), ip_address = $1
     WHERE user_id = $2`,
    [ip, studentId]
  ).catch(() => {});

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/tab-event
// Reports a student's browser navigation to the backend.
// Teachers can see this in real-time via the dashboard (Phase 6).
// Body: { url, title }
// ---------------------------------------------------------------------------
router.post('/tab-event', authenticate, async (req, res) => {
  const { url, title = '' } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const studentId = req.user.userId;

  const ts = Date.now();

  // Write to Redis stream for persistence / audit
  await redis.xadd(
    'classguard:tab-events',
    'MAXLEN', '~', 10000,
    '*',
    'student_id', studentId,
    'url',        url.substring(0, 1000),
    'title',      title.substring(0, 200),
    'ts',         ts.toString()
  ).catch(() => {});

  // Emit to teacher dashboards via the Socket.io bridge
  events.emit('student:activity', {
    studentId,
    url:   url.substring(0, 1000),
    title: title.substring(0, 200),
    ts,
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/v1/extension/policy
// Returns the student's effective policy (same as /users/me/effective-policy
// but also accepted by the extension without a double-auth round-trip).
// ---------------------------------------------------------------------------
router.get('/policy', authenticate, async (req, res) => {
  const policy = await resolvePolicy(req.user.userId);
  res.json(policy);
});

module.exports = router;
