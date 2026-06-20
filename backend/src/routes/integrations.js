const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const zammad  = require('../services/zammad');
const mosyle  = require('../services/mosyle');
const snipeit = require('../services/snipeit');
const google  = require('../services/google');
const phpipam = require('../services/phpipam');

const auth = [authenticate, requireMinRole('admin')];

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
         'mosyle_access_token',
         'snipeit_url','snipeit_token',
         'phpipam_url','phpipam_app_id',
         'last_mosyle_sync','last_snipeit_sync','last_zammad_sync','last_google_sync',
         'last_mosyle_error','last_snipeit_error','last_zammad_error','last_google_error',
         'google_client_id','google_client_secret'
       )`
    ),
    pool.query(`SELECT source, COUNT(*) AS count FROM integration_devices GROUP BY source`),
  ]);
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const deviceCount = Object.fromEntries(counts.map(r => [r.source, parseInt(r.count, 10)]));

  res.json({
    zammad:   { configured: !!(cfg.zammad_url && cfg.zammad_token),    lastSync: cfg.last_zammad_sync  || null, lastError: cfg.last_zammad_error  || null },
    mosyle:   { configured: !!cfg.mosyle_access_token,                 lastSync: cfg.last_mosyle_sync  || null, lastError: cfg.last_mosyle_error  || null, deviceCount: deviceCount.mosyle  ?? 0 },
    snipeit:  { configured: !!(cfg.snipeit_url && cfg.snipeit_token),  lastSync: cfg.last_snipeit_sync || null, lastError: cfg.last_snipeit_error || null, deviceCount: deviceCount.snipeit ?? 0 },
    google:   { configured: !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || (cfg.google_client_id && cfg.google_client_secret)), lastSync: cfg.last_google_sync || null, lastError: cfg.last_google_error || null, deviceCount: deviceCount.google_admin ?? 0 },
    phpipam:  { configured: !!(cfg.phpipam_url && cfg.phpipam_app_id) },
  });
});

// ---------------------------------------------------------------------------
// Devices — unified view across all integration sources
// ---------------------------------------------------------------------------

// GET /api/v1/integrations/devices?source=&search=&page=&limit=
router.get('/devices', ...auth, async (req, res) => {
  const { source, search, page = 1, limit = 50 } = req.query;
  const conditions = [];
  const values     = [];

  if (source) {
    conditions.push(`d.source = $${values.length + 1}`);
    values.push(source);
  }
  if (search) {
    conditions.push(
      `(d.device_name ILIKE $${values.length + 1} OR d.serial_number ILIKE $${values.length + 1}
        OR d.assigned_email ILIKE $${values.length + 1} OR d.assigned_user ILIKE $${values.length + 1})`
    );
    values.push(`%${search}%`);
  }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  try {
    const [{ rows }, { rows: total }] = await Promise.all([
      pool.query(
        `SELECT * FROM integration_devices ${where}
         ORDER BY synced_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM integration_devices ${where}`, values),
    ]);
    res.json({ devices: rows, total: parseInt(total[0].count, 10), page: parseInt(page, 10) });
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

// POST /api/v1/integrations/sync/google-devices  — sync Chromebook/device inventory
router.post('/sync/google-devices', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  recordSyncOutcome('google', syncGoogleDevices(req.user.id));
});

async function syncGoogleDevices(actorId) {
  const { google: googleLib } = require('googleapis');
  const config = require('../config');

  const keyPath    = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const superadmin = process.env.SUPERADMIN_EMAIL;
  if (!keyPath || !superadmin) throw new Error('Service account not configured');

  const auth = new googleLib.auth.GoogleAuth({
    keyFile: keyPath,
    scopes:  ['https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly'],
    clientOptions: { subject: superadmin },
  });

  const admin   = googleLib.admin({ version: 'directory_v1', auth });
  const devices = [];
  let pageToken;

  do {
    const res = await admin.chromeosdevices.list({
      customerId:  process.env.GOOGLE_CUSTOMER_ID || 'my_customer',
      maxResults:  200,
      ...(pageToken ? { pageToken } : {}),
    });
    devices.push(...(res.data.chromeosdevices || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  for (const d of devices) {
    // lastKnownNetwork holds the device's most recent LAN (ipAddress) and
    // WAN/public (wanIpAddress) addresses — a Chromebook taken home reports
    // its home router's public IP here, not anything on our network. Both
    // get stored; services/integrationDeviceIpamSync.js decides which (if
    // any) actually fall inside a documented IPAM subnet before registering
    // anything — see the "offsite devices" discussion this came from.
    const net = (d.lastKnownNetwork || [])[0] || {};
    const ips = [...new Set([net.ipAddress, net.wanIpAddress].filter(Boolean))];

    await pool.query(
      `INSERT INTO integration_devices
         (source, external_id, serial_number, mac_addresses, device_name, device_model,
          os_type, os_version, assigned_email, ip_addresses, status, last_seen, raw_data, synced_at)
       VALUES ('google_admin',$1,$2,$3,$4,$5,'ChromeOS',$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (source, external_id) DO UPDATE SET
         serial_number = EXCLUDED.serial_number, mac_addresses = EXCLUDED.mac_addresses,
         device_name = EXCLUDED.device_name, os_version = EXCLUDED.os_version,
         assigned_email = EXCLUDED.assigned_email, ip_addresses = EXCLUDED.ip_addresses,
         status = EXCLUDED.status,
         last_seen = EXCLUDED.last_seen, raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
      [d.deviceId, d.serialNumber,
       `{${[d.macAddress, d.ethernetMacAddress].filter(Boolean).join(',')}}`,
       d.annotatedAssetId || d.deviceId, d.model,
       d.osVersion, d.lastEnrollmentTime ? d.annotatedUser || null : null,
       `{${ips.join(',')}}`,
       d.status, d.lastSync ? new Date(d.lastSync) : null, JSON.stringify(d)]
    );
  }
}

// ---------------------------------------------------------------------------
// Zammad tickets
// ---------------------------------------------------------------------------

// GET /api/v1/integrations/tickets?state=&page=
router.get('/tickets', ...auth, async (req, res) => {
  try {
    const { page = 1, state } = req.query;
    const rows = await zammad.listTickets({ page: parseInt(page, 10), state });
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

// ---------------------------------------------------------------------------
// PHPiPAM import
// ---------------------------------------------------------------------------

// POST /api/v1/integrations/phpipam/import  — async full import
router.post('/phpipam/import', ...auth, async (req, res) => {
  res.json({ status: 'started', message: 'PHPiPAM import running in background' });
  phpipam.runImport(msg => console.log('[phpipam]', msg))
    .catch(err => console.error('[phpipam] import failed:', err.message));
});

// POST /api/v1/integrations/phpipam/test  — test connection (call after saving settings)
// Note: never respond 401 here — that status code makes the frontend's fetch
// wrapper treat it as "your ClassGuard session expired" and force a logout/
// redirect, masking whatever PHPiPAM-side error actually occurred.
router.post('/phpipam/test', ...auth, async (req, res) => {
  try {
    await phpipam.testConnection();
    res.json({ ok: true, message: 'PHPiPAM connection successful' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
