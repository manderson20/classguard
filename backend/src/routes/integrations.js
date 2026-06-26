const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const zammad  = require('../services/zammad');
const mosyle  = require('../services/mosyle');
const snipeit = require('../services/snipeit');
const google  = require('../services/google');
const { getUnifiedDevices } = require('../services/deviceConsolidation');

const auth = [authenticate, requirePermission('integrations')];

// ---------------------------------------------------------------------------
// Integration status / config
// ---------------------------------------------------------------------------

// GET /api/v1/integrations/status  — which integrations are configured
router.get('/status', ...auth, async (req, res) => {
  const [{ rows }, { rows: counts }] = await Promise.all([
    pool.query(
      `SELECT key, value FROM settings
       WHERE key IN (
         'zammad_url','zammad_token',
         'mosyle_access_token','mosyle_email','mosyle_password',
         'snipeit_url','snipeit_token','snipeit_client_id','snipeit_client_secret',
         'last_mosyle_sync','last_snipeit_sync','last_zammad_sync','last_google_sync',
         'last_mosyle_error','last_snipeit_error','last_zammad_error','last_google_error',
         'last_google_devices_sync','last_google_devices_error',
         'google_client_id','google_client_secret',
         'google_service_account_json','google_superadmin_email'
       )`
    ),
    pool.query(`SELECT source, COUNT(*) AS count FROM integration_devices GROUP BY source`),
  ]);
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const deviceCount = Object.fromEntries(counts.map(r => [r.source, parseInt(r.count, 10)]));

  // "configured" here means directory/device sync can actually run, which needs the
  // service account + superadmin email — NOT the same as google_client_id/secret,
  // which is the separate Web-application OAuth client used only for admin/teacher
  // SSO login. A site can have SSO working with zero ability to sync devices, and
  // vice versa.
  const googleSyncConfigured = !!(
    (cfg.google_service_account_json || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH) &&
    (cfg.google_superadmin_email || process.env.SUPERADMIN_EMAIL)
  );

  res.json({
    zammad:   { configured: !!(cfg.zammad_url && cfg.zammad_token),    lastSync: cfg.last_zammad_sync  || null, lastError: cfg.last_zammad_error  || null },
    mosyle:   { configured: !!(cfg.mosyle_access_token && cfg.mosyle_email && cfg.mosyle_password), lastSync: cfg.last_mosyle_sync  || null, lastError: cfg.last_mosyle_error  || null, deviceCount: deviceCount.mosyle  ?? 0 },
    snipeit:  { configured: !!(cfg.snipeit_url && (cfg.snipeit_token || (cfg.snipeit_client_id && cfg.snipeit_client_secret))), lastSync: cfg.last_snipeit_sync || null, lastError: cfg.last_snipeit_error || null, deviceCount: deviceCount.snipeit ?? 0 },
    google:   { configured: googleSyncConfigured, lastSync: cfg.last_google_sync || null, lastError: cfg.last_google_error || null },
    googleDevices: { configured: googleSyncConfigured, lastSync: cfg.last_google_devices_sync || null, lastError: cfg.last_google_devices_error || null, deviceCount: deviceCount.google_admin ?? 0 },
  });
});

// ---------------------------------------------------------------------------
// Devices — unified view across all integration sources
//
// One row per physical device, merged across Snipe-IT/Mosyle/Google by
// serial number (see services/deviceConsolidation.js for why), with live
// network presence from UniFi (network_clients) overlaid by MAC match.
// Total device count here is intentionally lower than the sum of each
// source's raw row count — that's the point, the same Chromebook showing up
// in both Snipe-IT and Google Workspace is one device, not two.
// ---------------------------------------------------------------------------

// GET /api/v1/integrations/devices?source=&search=&page=&limit=
router.get('/devices', ...auth, async (req, res) => {
  const { source, search, page = 1, limit = 50 } = req.query;
  try {
    let unified = await getUnifiedDevices();

    if (source) unified = unified.filter(d => d.sources.some(s => s.source === source));
    if (search) {
      const q = search.toLowerCase();
      unified = unified.filter(d =>
        (d.deviceName    || '').toLowerCase().includes(q) ||
        (d.serialNumber  || '').toLowerCase().includes(q) ||
        (d.assignedEmail || '').toLowerCase().includes(q) ||
        (d.assignedUser  || '').toLowerCase().includes(q)
      );
    }

    unified.sort((a, b) => (b.lastSynced ? new Date(b.lastSynced).getTime() : 0) - (a.lastSynced ? new Date(a.lastSynced).getTime() : 0));

    const p      = Math.max(parseInt(page, 10) || 1, 1);
    const l      = parseInt(limit, 10) || 50;
    const offset = (p - 1) * l;

    res.json({ devices: unified.slice(offset, offset + l), total: unified.length, page: p });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/integrations/devices/:id
router.get('/devices/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM integration_devices WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Device not found' });

    // Find linked Zammad tickets
    const { rows: tickets } = await pool.query(
      `SELECT zammad_id, number, title, state, priority, customer_email, created_at
       FROM zammad_tickets WHERE related_device_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.params.id]
    );

    res.json({ ...rows[0], tickets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sync endpoints (all async — respond immediately)
//
// These run after the response is sent, so the only way an admin can learn
// whether a sync actually succeeded is by checking GET /status afterward —
// previously a failure only went to console.error and was invisible in the
// UI (it looked identical to "succeeded with 0 devices"). recordSyncOutcome
// persists a last_<key>_error setting on failure and clears it on success,
// which GET /status now returns as lastError per integration.
// ---------------------------------------------------------------------------

async function recordSyncOutcome(key, promise) {
  try {
    await promise;
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1,'',NOW())
       ON CONFLICT (key) DO UPDATE SET value='', updated_at=NOW()`,
      [`last_${key}_error`]
    );
  } catch (err) {
    console.error(`[integrations] ${key} sync:`, err.message);
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [`last_${key}_error`, err.message]
    ).catch(() => {});
  }
}

router.post('/sync/mosyle', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  recordSyncOutcome('mosyle', mosyle.syncDevices());
});

router.post('/sync/snipeit', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  recordSyncOutcome('snipeit', snipeit.syncAssets());
});

router.post('/sync/google', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  recordSyncOutcome('google', google.syncAll(req.user.id));
});

// GET /api/v1/integrations/google/ou-role-preview — every distinct OU
// actually present among synced users, with its current count/role and what
// role the active rules would resolve it to right now. Lets an admin spot
// OUs that fall through to the 'student' default (e.g. /IT, /Staff,
// /k12itc) without having to guess which OU names exist or eyeball the
// Users page one row at a time.
router.get('/google/ou-role-preview', ...auth, async (req, res) => {
  const rules = await google.getOuRoleRules();
  const { rows } = await pool.query(
    `SELECT google_ou, role, role_source, count(*) AS count FROM users
     WHERE google_ou IS NOT NULL AND google_ou <> ''
     GROUP BY google_ou, role, role_source ORDER BY count DESC`
  );
  res.json(rows.map(r => ({
    ou:           r.google_ou,
    count:        parseInt(r.count, 10),
    currentRole:  r.role,
    roleSource:   r.role_source,
    resolvedRole: google.resolveRoleFromOu(r.google_ou, rules),
  })));
});

// POST /api/v1/integrations/google/backfill-roles — re-applies the current
// OU role rules to every non-manually-overridden user immediately, instead
// of waiting for the next scheduled directory sync. Runs synchronously
// (fast — it's an in-memory loop over already-synced users, no Google API
// calls) so the UI can show "Updated N users" right away.
router.post('/google/backfill-roles', ...auth, async (req, res) => {
  try {
    const result = await google.backfillRolesFromOu(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/integrations/sync/google-devices  — sync Chromebook/device inventory
// Separate error/timestamp tracking from 'google' (users/groups/OUs) above —
// they're independent operations (one can fail while the other succeeds,
// e.g. a directory-sync bug masking that devices already synced fine) and
// sharing one key made the status UI show a stale/unrelated error.
router.post('/sync/google-devices', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  recordSyncOutcome('google_devices', google.syncDevices(req.user.id));
});

// ---------------------------------------------------------------------------
// Zammad tickets
// ---------------------------------------------------------------------------

// GET /api/v1/integrations/zammad/test — verify credentials
router.get('/zammad/test', ...auth, async (req, res) => {
  try {
    const info = await zammad.testConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.response?.data?.error || err.message });
  }
});

// GET /api/v1/integrations/zammad/groups — list available groups for ticket creation
router.get('/zammad/groups', ...auth, async (req, res) => {
  try {
    const groups = await zammad.getGroups();
    res.json(groups);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/v1/integrations/tickets?page=
router.get('/tickets', ...auth, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const rows = await zammad.listTickets({ page: parseInt(page, 10) });
    res.json(rows);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/v1/integrations/tickets  — create a new Zammad ticket
router.post('/tickets', ...auth, async (req, res) => {
  try {
    const ticket = await zammad.createTicket({
      title:         req.body.title,
      body:          req.body.body,
      customerEmail: req.body.customerEmail,
      group:         req.body.group,
      priority:      req.body.priority,
      tags:          req.body.tags,
    });
    res.status(201).json(ticket);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/v1/integrations/tickets/:id/note
router.post('/tickets/:id/note', ...auth, async (req, res) => {
  try {
    const note = await zammad.addTicketNote(req.params.id, req.body.body, req.body.internal ?? true);
    res.json(note);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/sync/tickets', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  recordSyncOutcome('zammad', zammad.syncTickets().then(count => pool.query(
    `INSERT INTO settings (key,value,updated_at) VALUES ('last_zammad_sync',$1,NOW())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [new Date().toISOString()]
  ).then(() => count)));
});

module.exports = router;
