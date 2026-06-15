const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const jwt    = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const oauthClient = new OAuth2Client(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

// POST /api/v1/auth/google
// Body: { code: string }  — Google OAuth authorization code from the frontend
router.post('/google', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Authorization code required' });

  try {
    const { tokens } = await oauthClient.getToken(code);
    oauthClient.setCredentials(tokens);

    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.google.clientId,
    });

    const payload = ticket.getPayload();
    const {
      sub:        googleId,
      email,
      name:       fullName,
      given_name: givenName,
      picture:    photoUrl,
      hd:         hostedDomain,
    } = payload;

    if (config.google.workspaceDomain && hostedDomain !== config.google.workspaceDomain) {
      return res.status(403).json({ error: 'Account domain not authorized for this ClassGuard instance' });
    }

    // Bootstrap: first user whose email matches SUPERADMIN_EMAIL gets superadmin role
    const { rows: countRows } = await query('SELECT COUNT(*) AS count FROM users');
    const isFirstUser    = parseInt(countRows[0].count, 10) === 0;
    const isSuperadmin   = email === config.superadminEmail;
    const bootstrapRole  = isFirstUser && isSuperadmin ? 'superadmin' : null;

    const { rows } = await query(
      `INSERT INTO users (google_id, email, full_name, given_name, photo_url, role, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (google_id) DO UPDATE SET
         email          = EXCLUDED.email,
         full_name      = EXCLUDED.full_name,
         given_name     = EXCLUDED.given_name,
         photo_url      = EXCLUDED.photo_url,
         last_synced_at = NOW(),
         updated_at     = NOW()
       RETURNING *`,
      [googleId, email, fullName, givenName, photoUrl, bootstrapRole ?? 'student']
    );

    const user = rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

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
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ error: 'Authentication failed' });
  }
});

// GET /api/v1/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, email, full_name, given_name, photo_url, role, google_ou, is_active
       FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('Me error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/auth/refresh
// Accepts a still-valid JWT and issues a fresh one (resets expiry clock)
router.post('/refresh', authenticate, (req, res) => {
  const token = jwt.sign(
    { userId: req.user.userId, email: req.user.email, role: req.user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
  return res.json({ token });
});

// DELETE /api/v1/auth/logout  — JWT is stateless; client discards the token
router.delete('/logout', (req, res) => res.status(204).send());

module.exports = router;
