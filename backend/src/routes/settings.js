const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

const auth = [authenticate, requireMinRole('admin')];

// Keys that admins are allowed to read/write via this endpoint
const ALLOWED_KEYS = new Set([
  'google_client_id', 'google_client_secret', 'google_redirect_uri',
  'google_workspace_domain', 'google_customer_id',
  'default_policy_id', 'blocklist_sync_cron', 'dns_log_retention_days',
  'last_google_sync', 'google_ous',
  // Integrations
  'zammad_url', 'zammad_token',
  'mosyle_access_token',
  'snipeit_url', 'snipeit_token',
  'phpipam_url', 'phpipam_app_id', 'phpipam_username', 'phpipam_password',
  'last_mosyle_sync', 'last_snipeit_sync', 'last_zammad_sync',
  // AD/LDAP
  'ldap_url', 'ldap_bind_dn', 'ldap_bind_password', 'ldap_base_dn', 'ldap_user_filter',
  // AI classification
  'ai_provider', 'ai_api_key', 'ai_model', 'ai_base_url',
  // YouTube Data API
  'youtube_api_key',
  // Block page branding
  'blockpage_school_name', 'blockpage_logo', 'blockpage_message',
  'blockpage_contact_email', 'blockpage_primary_color',
  // Unblock requests & override codes
  'unblock_requests_who', 'override_codes_enabled',
  // Zabbix
  'zabbix_metrics_token',
  // Roster sync
  'last_classroom_sync',
  // RADIUS / Google Secure LDAP
  'ldap_google_enabled', 'ldap_client_cert_path', 'ldap_client_key_path',
  'ldap_base_dn', 'ldap_google_domain',
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
