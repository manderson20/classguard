const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

const auth = [authenticate, requireMinRole('admin')];

// Keys that admins are allowed to read/write via this endpoint
const ALLOWED_KEYS = new Set([
  'google_client_id',
  'google_client_secret',
  'google_redirect_uri',
  'google_workspace_domain',
  'google_customer_id',
  'default_policy_id',
  'blocklist_sync_cron',
  'dns_log_retention_days',
  'last_google_sync',
  'google_ous',
]);

// GET /api/v1/settings  — returns all allowed settings as a key→value object
router.get('/', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
      [[...ALLOWED_KEYS]]
    );
    const result = Object.fromEntries(rows.map(r => [r.key, r.value]));
    // Also surface the app version
    result.version = process.env.npm_package_version || '0.0.1';
    res.json(result);
  } catch (err) {
    console.error('[settings] GET error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PUT /api/v1/settings  — upsert one or more settings keys
// Body: { key: value, ... }  (only ALLOWED_KEYS are accepted)
router.put('/', ...auth, async (req, res) => {
  const updates = Object.entries(req.body).filter(([k]) => ALLOWED_KEYS.has(k));

  if (!updates.length) {
    return res.status(400).json({ error: 'No valid settings keys provided' });
  }

  try {
    for (const [key, value] of updates) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value == null ? null : String(value)]
      );
    }
    res.json({ saved: updates.map(([k]) => k) });
  } catch (err) {
    console.error('[settings] PUT error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
