const express = require('express');
const crypto  = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const { google: googleApis } = require('googleapis');
const jwt    = require('jsonwebtoken');
const config = require('../config');
const { query, pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { getServiceAccountAuth, getOuRoleRules, resolveRoleFromOu } = require('../services/google');
const { hashPassword, verifyPassword } = require('../services/passwordHash');

const router = express.Router();

// Brute-force guard on credential-checking endpoints specifically — the
// general /api/ limiter (index.js) is sized for dashboard polling, not for
// stopping password guessing, so login/google get their own tighter one.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in a few minutes' },
});

// ---------------------------------------------------------------------------
// Load Google OAuth credentials — env vars take precedence, DB settings fallback
// ---------------------------------------------------------------------------
async function getGoogleConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('google_client_id','google_client_secret','google_redirect_uri','google_workspace_domain')`
  );
  const db = Object.fromEntries(rows.map(r => [r.key, r.value]));

  return {
    clientId:        config.google.clientId        || db.google_client_id        || null,
    clientSecret:    config.google.clientSecret    || db.google_client_secret    || null,
    redirectUri:     config.google.redirectUri     || db.google_redirect_uri     || null,
    workspaceDomain: config.google.workspaceDomain || db.google_workspace_domain || null,
  };
}

function issueJwt(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

function publicUser(user) {
  return {
    id:       user.id,
    email:    user.email,
    name:     user.full_name,
    role:     user.role,
    photoUrl: user.photo_url,
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/auth/setup-status
// Returns whether first-run setup is still needed (no users in DB).
// ---------------------------------------------------------------------------
router.get('/setup-status', async (req, res) => {
  try {
    const { rows } = await query('SELECT COUNT(*) AS count FROM users');
    res.json({ needsSetup: parseInt(rows[0].count, 10) === 0 });
  } catch (err) {
    res.status(500).json({ error: 'DB unavailable' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/auth/public-config
// Returns non-secret settings the login page needs (Google client ID).
// ---------------------------------------------------------------------------
router.get('/public-config', async (req, res) => {
  try {
    const goog = await getGoogleConfig();
    res.json({ googleClientId: goog.clientId ?? null });
  } catch {
    res.json({ googleClientId: null });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/setup
// First-run only: creates the superadmin account with a local password.
// Fails if any user already exists.
// ---------------------------------------------------------------------------
router.post('/setup', async (req, res) => {
  const { email, password, fullName } = req.body;

  if (!email || !password || !fullName) {
    return res.status(400).json({ error: 'email, password, and fullName are required' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }

  try {
    const { rows: countRows } = await query('SELECT COUNT(*) AS count FROM users');
    if (parseInt(countRows[0].count, 10) > 0) {
      return res.status(409).json({ error: 'Setup already complete — use the login page' });
    }

    const hash = hashPassword(password);
    const googleId = `local:${crypto.randomBytes(8).toString('hex')}`;

    const { rows } = await query(
      `INSERT INTO users (google_id, email, full_name, given_name, role, password_hash, last_synced_at)
       VALUES ($1, $2, $3, $4, 'superadmin', $5, NOW())
       RETURNING *`,
      [googleId, email.toLowerCase().trim(), fullName, fullName.split(' ')[0], hash]
    );

    const user  = rows[0];
    const token = issueJwt(user);

    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('[auth] setup error:', err);
    res.status(500).json({ error: 'Failed to create admin account' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// Local email + password login (for accounts created via setup or by an admin).
// ---------------------------------------------------------------------------
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  try {
    const { rows } = await query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];

    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = issueJwt(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/google
// Exchange Google OAuth code for a JWT.
// ---------------------------------------------------------------------------
router.post('/google', loginLimiter, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Authorization code required' });

  try {
    const goog = await getGoogleConfig();
    if (!goog.clientId || !goog.clientSecret || !goog.redirectUri) {
      return res.status(503).json({
        error: 'Google OAuth is not configured. Ask your administrator to add credentials in Settings.',
      });
    }

    const oauthClient = new OAuth2Client(goog.clientId, goog.clientSecret, goog.redirectUri);
    const { tokens }  = await oauthClient.getToken(code);
    oauthClient.setCredentials(tokens);

    const ticket = await oauthClient.verifyIdToken({
      idToken:  tokens.id_token,
      audience: goog.clientId,
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name: fullName, given_name: givenName,
            picture: photoUrl, hd: hostedDomain } = payload;

    // workspaceDomain may be a comma-separated list — a single Workspace
    // account commonly spans several domains/subdomains (e.g. staff on
    // example.org and a second legacy domain, students on
    // students.example.org), and Google's hd claim reflects whichever one
    // the signing-in account actually belongs to.
    const allowedDomains = (goog.workspaceDomain || '')
      .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    if (allowedDomains.length && !allowedDomains.includes((hostedDomain || '').toLowerCase())) {
      return res.status(403).json({ error: 'Account domain not authorized for this ClassGuard instance' });
    }

    // Role is only ever decided here for a brand-new user (ON CONFLICT below
    // never touches role) — the OIDC token carries no OU info, so a user who
    // hasn't been through a directory sync yet (e.g. signing in the moment
    // they're hired, before the next scheduled sync) needs a direct Admin SDK
    // lookup. Best-effort: any failure here (service account not configured,
    // user not found, etc.) just falls back to 'student' rather than
    // blocking login — the next directory sync will correct it anyway.
    let role = 'student';
    try {
      const auth  = await getServiceAccountAuth(['https://www.googleapis.com/auth/admin.directory.user.readonly']);
      const admin = googleApis.admin({ version: 'directory_v1', auth });
      const { data } = await admin.users.get({ userKey: email });
      const rules = await getOuRoleRules();
      role = resolveRoleFromOu(data.orgUnitPath, rules);
    } catch {
      // service account not configured, or this user has no directory record yet
    }

    // Conflict target is email, not google_id — same reason as google.js's
    // syncUsers: a OneRoster-imported staff/student row can have a NULL
    // google_id, and Postgres treats every NULL as distinct for a unique
    // constraint, so ON CONFLICT (google_id) would silently miss it and hit
    // the separate email-uniqueness violation on the INSERT instead.
    let user;
    try {
      const { rows } = await query(
        `INSERT INTO users (google_id, email, full_name, given_name, photo_url, role, role_source, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'auto', NOW())
         ON CONFLICT (email) DO UPDATE SET
           google_id      = EXCLUDED.google_id,
           full_name      = EXCLUDED.full_name,
           given_name     = EXCLUDED.given_name,
           photo_url      = EXCLUDED.photo_url,
           last_synced_at = NOW(),
           updated_at     = NOW()
         RETURNING *`,
        [googleId, email, fullName, givenName, photoUrl, role]
      );
      user = rows[0];
    } catch (writeErr) {
      // Standby nodes have a read-only streaming replica — writes fail with
      // error code 25006 (ReadOnlySqlTransaction). Fall back to SELECT so
      // existing users can still sign in; profile updates (photo, name, etc.)
      // will catch up on the next directory sync from the primary.
      if (writeErr.code === '25006') {
        const { rows } = await query(
          'SELECT * FROM users WHERE email = $1',
          [email]
        );
        user = rows[0];
        if (!user) throw writeErr;
      } else {
        throw writeErr;
      }
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    res.json({ token: issueJwt(user), user: publicUser(user) });
  } catch (err) {
    console.error('[auth] google error:', err.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/auth/me
// ---------------------------------------------------------------------------
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, email, full_name, given_name, photo_url, role, google_ou, is_active
       FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({
      ...rows[0],
      // Present only when this token came from POST /impersonation/:id/start
      // (routes/impersonation.js) -- the frontend uses this to show the
      // "viewing as" banner and to know whether there's an admin session to
      // return to. Never set on a normal login token.
      impersonatedBy:          req.user.impersonatedBy || null,
      impersonationSessionId:  req.user.impersonationSessionId || null,
    });
  } catch (err) {
    console.error('[auth] me error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/refresh
// ---------------------------------------------------------------------------
router.post('/refresh', authenticate, (req, res) => {
  // An impersonation token re-minted here with the normal expiresIn would
  // silently turn a deliberately short, audited "view as" session into a
  // persistent, untracked teacher identity -- the impersonatedBy claim
  // would either have to be dropped (losing the audit trail entirely) or
  // carried forward indefinitely (defeating the whole point of a short
  // TTL). Simplest safe answer: impersonation sessions can't be refreshed
  // at all -- end this one and start a fresh one if more time is needed.
  if (req.user.impersonatedBy) {
    return res.status(403).json({ error: 'Impersonation sessions cannot be refreshed — end this session and start a new one if more time is needed' });
  }
  const token = jwt.sign(
    { userId: req.user.userId, email: req.user.email, role: req.user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
  res.json({ token });
});

// DELETE /api/v1/auth/logout
router.delete('/logout', (req, res) => res.status(204).send());

module.exports = router;
