const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const config              = require('../config');

const auth = [authenticate, requirePermission('settings')];

// Keys that admins are allowed to read/write via this endpoint
const ALLOWED_KEYS = new Set([
  'google_client_id', 'google_client_secret', 'google_redirect_uri',
  'google_workspace_domain', 'google_customer_id',
  // Service account for Admin SDK directory/device sync (Integrations >
  // Google Workspace > Device & Directory Sync) — a third, distinct Google
  // credential from google_client_id/secret above (Web app OAuth, SSO login)
  // and extension_oauth_client_id below (Chrome Extension OAuth, chrome.identity).
  'google_service_account_json', 'google_superadmin_email',
  // Chrome extension build config (Integrations > Chrome Extension) — a
  // separate OAuth client from google_client_id above: chrome.identity
  // requires an "Chrome Extension"-type client tied to the extension's ID,
  // not the "Web application"-type client used for admin/teacher SSO login.
  'extension_oauth_client_id', 'extension_public_url',
  'default_policy_id', 'blocklist_sync_cron', 'dns_log_retention_days',
  'last_google_sync', 'google_ous', 'google_ou_role_rules',
  // Integrations
  'zammad_url', 'zammad_token',
  // mosyle_email/password: Mosyle Manager's token-only auth is deprecated;
  // an admin login is required for the JWT /login exchange (see services/mosyle.js).
  'mosyle_access_token', 'mosyle_email', 'mosyle_password',
  'snipeit_url', 'snipeit_token', 'snipeit_client_id', 'snipeit_client_secret',
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
  'radius_default_nas_secret',
  // HA Cluster > Software Updates — only needed because the classguard repo
  // is private; GitHub's Contents API 404s on an unauthenticated request to
  // a private repo (indistinguishable from "doesn't exist"), which silently
  // broke the whole check-for-update -> schedule-update flow.
  'github_update_token',
  // Mail relay connection (Settings > Communications) — reusable
  // infrastructure for any feature that sends email. Who actually receives
  // a safety alert (safety_alert_emails) is a separate, narrower-permissioned
  // concern — see /safety-alert-recipients below.
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from',
  // First-time setup wizard — tracks whether the guided onboarding flow has
  // been completed so superadmins aren't redirected to it on every login.
  'setup_wizard_complete',
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
    result.version = config.version;
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

// safety_alert_emails is governed by its own 'safety_alerts' permission
// (Safety Alerts > Alerting), not the blanket 'settings' permission that
// guards everything else in this file — it's an application-level decision
// (who should know about a safety event), not core server config, and a
// custom role can be granted one without the other. Reusing PUT/GET /
// for this one key would mean a safety_alerts-only user could read/write
// every other key here too (Google credentials, LDAP passwords, ...), so
// it gets a narrow, dedicated pair of routes instead.
const safetyAlertsAuth = [authenticate, requirePermission('safety_alerts')];

router.get('/safety-alert-recipients', ...safetyAlertsAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'safety_alert_emails'`);
  res.json({ safety_alert_emails: rows[0]?.value || '' });
});

router.put('/safety-alert-recipients', ...safetyAlertsAuth, async (req, res) => {
  const { safety_alert_emails } = req.body;
  if (safety_alert_emails === undefined) return res.status(400).json({ error: 'safety_alert_emails required' });
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('safety_alert_emails', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(safety_alert_emails)]
  );
  res.json({ saved: ['safety_alert_emails'] });
});

// Active-hours window for Filter Bypass detection (services/
// filterBypassDetection.js) — same permission as the recipients above,
// same reasoning: this gates a safety-alerting behavior, not core server
// config, so it shouldn't ride on the blanket 'settings' permission.
const FILTER_BYPASS_KEYS = ['filter_bypass_active_start', 'filter_bypass_active_end', 'filter_bypass_active_days'];

router.get('/filter-bypass-hours', ...safetyAlertsAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [FILTER_BYPASS_KEYS]);
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({
    start: cfg.filter_bypass_active_start || '07:00',
    end:   cfg.filter_bypass_active_end   || '16:00',
    days:  cfg.filter_bypass_active_days  || '1,2,3,4,5',
  });
});

router.put('/filter-bypass-hours', ...safetyAlertsAuth, async (req, res) => {
  const { start, end, days } = req.body;
  if (!start || !end || !days) return res.status(400).json({ error: 'start, end, and days are all required' });
  for (const [key, value] of [
    ['filter_bypass_active_start', start],
    ['filter_bypass_active_end', end],
    ['filter_bypass_active_days', days],
  ]) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(value)]
    );
  }
  res.json({ saved: FILTER_BYPASS_KEYS });
});

// POST /api/v1/settings/smtp/test — sends a real test email to an address
// the admin types in, so the mail relay itself can be verified right after
// configuring it, independent of any feature's recipient list (Safety
// Alerts has its own separate test against safety_alert_emails below).
router.post('/smtp/test', ...auth, async (req, res) => {
  const { to } = req.body;
  if (!to?.trim()) return res.status(400).json({ error: 'to address is required' });

  const { sendMail } = require('../services/mailer');
  try {
    const result = await sendMail({
      to: to.trim(),
      subject: '[ClassGuard] Test email',
      text: 'This is a test email from ClassGuard. If you received this, the mail server is configured correctly.',
    });
    if (!result.sent) return res.status(400).json({ error: result.reason });
    res.json({ ok: true, sentTo: to.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/settings/safety-alerts/test — sends a real test email to
// the configured safety_alert_emails list, so an admin can confirm SMTP
// works before relying on it for a real self-harm/violence alert.
router.post('/safety-alerts/test', ...safetyAlertsAuth, async (req, res) => {
  const { sendMail, getSmtpSettings } = require('../services/mailer');
  const cfg = await getSmtpSettings();
  const recipients = (cfg.safety_alert_emails || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return res.status(400).json({ error: 'No safety_alert_emails configured' });

  try {
    const result = await sendMail({
      to: recipients.join(','),
      subject: '[ClassGuard] Test safety alert',
      text: 'This is a test of the ClassGuard safety alert email. If you received this, delivery is working correctly.',
    });
    if (!result.sent) return res.status(400).json({ error: result.reason });
    res.json({ ok: true, sentTo: recipients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
