const { Router } = require('express');
const { pool }   = require('../db');
const { authenticate }      = require('../middleware/auth');
const { requireMinRole }    = require('../middleware/roles');
const fleetSync  = require('../services/fleetSync');
const snipeit    = require('../services/snipeit');
const google     = require('../services/google');
const deviceConsolidation = require('../services/deviceConsolidation');
const multer     = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();
router.use(authenticate, requireMinRole('admin'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aupStatus(aupDate) {
  if (!aupDate) return 'unknown';
  const now   = new Date();
  const exp   = new Date(aupDate);
  const msDay = 86_400_000;
  if (exp < now)               return 'expired';
  if (exp - now < 365 * msDay) return 'expiring';
  return 'ok';
}

function compareVersions(current, latest) {
  if (!current || !latest) return 'unknown';
  const toNum = v => v.split('.').map(n => parseInt(n) || 0);
  const c = toNum(current);
  const l = toNum(latest);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0, lv = l[i] ?? 0;
    if (cv < lv) return 'behind';
    if (cv > lv) return 'upToDate'; // ahead of reference (shouldn't happen)
  }
  return 'upToDate';
}

function escapeCsv(v) {
  const s = v == null ? '' : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// GET /fleet/summary
// ---------------------------------------------------------------------------
router.get('/summary', async (req, res) => {
  const [
    { rows: allDevices },
    { rows: aupRef },
    { rows: osRef },
    { rows: settings },
  ] = await Promise.all([
    pool.query(`SELECT source, serial_number, os_type, os_version, asset_tag, last_seen, external_id, device_model, aup_date FROM integration_devices`),
    pool.query(`SELECT model, aup_date, requires_license FROM chromebook_aup_reference`),
    pool.query(`SELECT os_family, latest_version FROM apple_os_reference`),
    pool.query(`SELECT key, value FROM settings WHERE key IN ('last_mosyle_sync','last_snipeit_sync','last_google_devices_sync')`),
  ]);

  const aupMap = Object.fromEntries(
    aupRef.map(r => [r.model?.toLowerCase(), { aup_date: r.aup_date, requires_license: r.requires_license }])
  );
  const osMap  = Object.fromEntries(osRef.map(r => [r.os_family, r.latest_version]));
  const syncs  = Object.fromEntries(settings.map(r => [r.key, r.value]));

  // Deduplicate by serial number (same physical device across sources)
  const bySerial = new Map();
  for (const d of allDevices) {
    const key = d.serial_number ? d.serial_number.trim().toUpperCase() : `__id__${d.source}`;
    if (!bySerial.has(key)) bySerial.set(key, []);
    bySerial.get(key).push(d);
  }

  const byOs = {};
  let chromebooks = { total: 0, expired: 0, expiringSoon: 0, ok: 0, unknown: 0 };
  let apple       = { total: 0, upToDate: 0, updateAvailable: 0, unknown: 0 };
  let offlineCount = 0;
  let gapCount = 0;

  for (const [, rows] of bySerial) {
    const osType = rows.find(r => r.os_type)?.os_type || 'Unknown';
    byOs[osType] = (byOs[osType] || 0) + 1;

    if (osType === 'ChromeOS') {
      chromebooks.total++;
      const googleRow  = rows.find(r => r.source === 'google_admin') || rows[0];
      const model      = googleRow?.device_model;
      // Prefer per-device AUP from Google Admin API, fall back to model table
      const deviceDate = googleRow?.aup_date || null;
      const refDate    = model ? aupMap[model.toLowerCase()]?.aup_date : null;
      const aupDate    = deviceDate || refDate;
      const status     = aupStatus(aupDate);
      if (status === 'expired')      chromebooks.expired++;
      else if (status === 'expiring') chromebooks.expiringSoon++;
      else if (status === 'ok')      chromebooks.ok++;
      else                            chromebooks.unknown++;
    }

    if (['macOS','iOS','iPadOS','tvOS'].includes(osType)) {
      apple.total++;
      const version = rows.find(r => r.os_version)?.os_version;
      const latest  = osMap[osType];
      const status  = compareVersions(version, latest);
      if (status === 'upToDate') apple.upToDate++;
      else if (status === 'behind') apple.updateAvailable++;
      else apple.unknown++;
    }

    const lastSeen = rows.map(r => r.last_seen).filter(Boolean).sort().pop();
    if (!lastSeen || (Date.now() - new Date(lastSeen).getTime()) > 30 * 86_400_000) offlineCount++;

    const hasSnipe = rows.some(r => r.source === 'snipeit');
    const hasMDM   = rows.some(r => r.source !== 'snipeit');
    if (!hasSnipe && hasMDM) gapCount++;
  }

  res.json({
    total:       bySerial.size,
    byOs,
    chromebooks,
    apple,
    offline:     offlineCount,
    gaps:        gapCount,
    lastSync: {
      mosyle:        syncs.last_mosyle_sync        || null,
      snipeit:       syncs.last_snipeit_sync        || null,
      googleDevices: syncs.last_google_devices_sync || null,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /fleet/devices
// ---------------------------------------------------------------------------
router.get('/devices', async (req, res) => {
  const { os, source, q } = req.query;
  const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
  const offset = parseInt(req.query.offset) || 0;

  const unified = await deviceConsolidation.getUnifiedDevices();

  let filtered = unified;
  if (os)     filtered = filtered.filter(d => d.osType === os);
  if (source) filtered = filtered.filter(d => d.sources.some(s => s.source === source));
  if (q) {
    const lq = q.toLowerCase();
    filtered = filtered.filter(d =>
      d.deviceName?.toLowerCase().includes(lq) ||
      d.serialNumber?.toLowerCase().includes(lq) ||
      d.assignedEmail?.toLowerCase().includes(lq) ||
      d.assetTag?.toLowerCase().includes(lq)
    );
  }

  res.json({ devices: filtered.slice(offset, offset + limit), total: filtered.length });
});

// ---------------------------------------------------------------------------
// GET /fleet/export.csv
// ---------------------------------------------------------------------------
router.get('/export.csv', async (req, res) => {
  const unified = await deviceConsolidation.getUnifiedDevices();
  const header  = 'Serial,Name,Model,OS,Version,Assigned,Status,Asset Tag,Sources,Last Seen';
  const body    = unified.map(d => [
    d.serialNumber, d.deviceName, d.deviceModel, d.osType, d.osVersion,
    d.assignedEmail, d.status, d.assetTag,
    d.sources.map(s => s.source).join('|'), d.lastSynced,
  ].map(escapeCsv).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="Device Fleet.csv"');
  res.send(`${header}\n${body}`);
});

// ---------------------------------------------------------------------------
// GET /fleet/chromebooks
// ---------------------------------------------------------------------------
router.get('/chromebooks', async (req, res) => {
  const { status: filterStatus } = req.query;

  const [{ rows: chromebookRows }, { rows: aupRef }] = await Promise.all([
    pool.query(
      `SELECT id.id, id.external_id, id.serial_number, id.device_name, id.device_model,
              id.os_version, id.assigned_email, id.asset_tag, id.synced_at,
              id.aup_date, id.aup_source, id.source, id.status
       FROM integration_devices id
       WHERE id.os_type = 'ChromeOS'`
    ),
    pool.query(`SELECT model, aup_date, requires_license FROM chromebook_aup_reference`),
  ]);

  const aupMap = Object.fromEntries(
    aupRef.map(r => [r.model?.toLowerCase(), { aup_date: r.aup_date, requires_license: r.requires_license }])
  );

  // Group by serial — Google Admin row is preferred (has per-device AUP date)
  const bySerial = new Map();
  for (const r of chromebookRows) {
    const s = r.serial_number?.trim().toUpperCase() || `__id__${r.id}`;
    if (!bySerial.has(s)) bySerial.set(s, []);
    bySerial.get(s).push(r);
  }

  const result = [];
  for (const [serial, rows] of bySerial) {
    const googleRow = rows.find(r => r.source === 'google_admin') || rows[0];
    const model     = googleRow.device_model;
    const modelKey  = model?.toLowerCase();

    // Per-device date from Google Admin API (authoritative — already reflects license/extension state)
    // Fall back to model reference table if no API date
    const deviceAupDate  = googleRow.aup_date || null;
    const refEntry       = modelKey ? aupMap[modelKey] : null;
    const refAupDate     = refEntry?.aup_date || null;
    const aupDate        = deviceAupDate || refAupDate;
    const aupSource      = deviceAupDate ? 'google_admin' : (refAupDate ? 'model_ref' : null);

    // requiresLicense is only relevant when we're using the model-table estimate
    // (the Admin API date already reflects whether extended support is active)
    const requiresLicense = aupSource === 'model_ref' && (refEntry?.requires_license === true);

    const status = aupStatus(aupDate);

    if (filterStatus && status !== filterStatus) continue;

    result.push({
      serialNumber:    serial,
      deviceName:      googleRow.device_name,
      deviceModel:     model,
      assignedEmail:   googleRow.assigned_email,
      assetTag:        rows.find(r => r.asset_tag)?.asset_tag || null,
      googleDeviceId:  rows.find(r => r.source === 'google_admin')?.external_id || null,
      googleStatus:    googleRow.status || 'ACTIVE',
      aupDate:         aupDate || null,
      aupSource,
      aupStatus:       status,
      requiresLicense,
      osVersion:       googleRow.os_version,
      lastSync:        googleRow.synced_at,
    });
  }

  result.sort((a, b) => {
    const order = { expired: 0, expiring: 1, unknown: 2, ok: 3 };
    return (order[a.aupStatus] ?? 4) - (order[b.aupStatus] ?? 4);
  });

  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /fleet/chromebooks/disable  body: { deviceIds: string[] }
// ---------------------------------------------------------------------------
router.post('/chromebooks/disable', async (req, res) => {
  const { deviceIds } = req.body;
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return res.status(400).json({ error: 'deviceIds array required' });
  }

  let disabled = 0;
  const errors = [];

  for (const id of deviceIds) {
    try {
      await google.setChromeDeviceAction(id, 'disable', req.user.userId);
      await pool.query(
        `UPDATE integration_devices SET status = 'DISABLED', synced_at = NOW()
         WHERE source = 'google_admin' AND external_id = $1`,
        [id]
      );
      disabled++;
    } catch (err) {
      errors.push(`${id}: ${err.message}`);
    }
  }

  res.json({ disabled, errors });
});

// ---------------------------------------------------------------------------
// POST /fleet/chromebooks/reenable  body: { deviceIds: string[] }
// ---------------------------------------------------------------------------
router.post('/chromebooks/reenable', async (req, res) => {
  const { deviceIds } = req.body;
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return res.status(400).json({ error: 'deviceIds array required' });
  }

  let reenabled = 0;
  const errors  = [];

  for (const id of deviceIds) {
    try {
      await google.setChromeDeviceAction(id, 'reenable', req.user.userId);
      await pool.query(
        `UPDATE integration_devices SET status = 'ACTIVE', synced_at = NOW()
         WHERE source = 'google_admin' AND external_id = $1`,
        [id]
      );
      reenabled++;
    } catch (err) {
      errors.push(`${id}: ${err.message}`);
    }
  }

  res.json({ reenabled, errors });
});

// ---------------------------------------------------------------------------
// POST /fleet/chromebooks/deprovision  body: { deviceIds: string[], reason: string }
// ---------------------------------------------------------------------------
router.post('/chromebooks/deprovision', async (req, res) => {
  const { deviceIds, reason } = req.body;
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return res.status(400).json({ error: 'deviceIds array required' });
  }
  if (!reason) {
    return res.status(400).json({ error: 'reason required' });
  }

  let deprovisioned = 0;
  const errors = [];

  for (const id of deviceIds) {
    try {
      await google.deprovisionChromeDevice(id, reason, req.user.userId);
      await pool.query(
        `UPDATE integration_devices SET status = 'DEPROVISIONED', synced_at = NOW()
         WHERE source = 'google_admin' AND external_id = $1`,
        [id]
      );
      deprovisioned++;
    } catch (err) {
      errors.push(`${id}: ${err.message}`);
    }
  }

  res.json({ deprovisioned, errors });
});

// ---------------------------------------------------------------------------
// GET /fleet/apple
// ---------------------------------------------------------------------------
router.get('/apple', async (req, res) => {
  const { os: filterOs, updateStatus: filterUpdate } = req.query;

  const APPLE_OS = ['macOS', 'iOS', 'iPadOS', 'tvOS'];

  const [{ rows: appleRows }, { rows: osRef }] = await Promise.all([
    pool.query(
      `SELECT id, serial_number, device_name, device_model, os_type, os_version,
              assigned_email, asset_tag, synced_at, source
       FROM integration_devices
       WHERE os_type = ANY($1)`,
      [APPLE_OS]
    ),
    pool.query(`SELECT os_family, latest_version FROM apple_os_reference`),
  ]);

  const osMap = Object.fromEntries(osRef.map(r => [r.os_family, r.latest_version]));

  // Deduplicate by serial — prefer Mosyle for technical fields
  const bySerial = new Map();
  for (const r of appleRows) {
    const s = r.serial_number?.trim().toUpperCase() || `__id__${r.id}`;
    if (!bySerial.has(s)) bySerial.set(s, []);
    bySerial.get(s).push(r);
  }

  const result = [];
  for (const [serial, rows] of bySerial) {
    const ref    = rows.find(r => r.source === 'mosyle') || rows[0];
    const osType = ref.os_type;

    if (filterOs && osType !== filterOs) continue;

    const latestVersion = osMap[osType] || null;
    const updateStatus  = compareVersions(ref.os_version, latestVersion);

    if (filterUpdate && updateStatus !== filterUpdate) continue;

    result.push({
      serialNumber:   serial,
      deviceName:     ref.device_name,
      deviceModel:    ref.device_model,
      osType,
      osVersion:      ref.os_version,
      latestVersion,
      updateStatus,
      assignedEmail:  rows.find(r => r.assigned_email)?.assigned_email || null,
      assetTag:       rows.find(r => r.asset_tag)?.asset_tag || null,
      lastSync:       ref.synced_at,
    });
  }

  result.sort((a, b) => {
    const order = { behind: 0, unknown: 1, upToDate: 2 };
    return (order[a.updateStatus] ?? 3) - (order[b.updateStatus] ?? 3);
  });

  res.json(result);
});

// ---------------------------------------------------------------------------
// OS reference CRUD
// ---------------------------------------------------------------------------
router.get('/apple/os-reference', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM apple_os_reference ORDER BY os_family`);
  res.json(rows);
});

router.put('/apple/os-reference/:family', async (req, res) => {
  const { latest_version, min_supported_version } = req.body;
  const { rows: [row] } = await pool.query(
    `UPDATE apple_os_reference
     SET latest_version=$1, min_supported_version=$2, updated_at=NOW()
     WHERE os_family=$3
     RETURNING *`,
    [latest_version, min_supported_version || null, req.params.family]
  );
  if (!row) return res.status(404).json({ error: 'OS family not found' });
  res.json(row);
});

// ---------------------------------------------------------------------------
// POST /fleet/apple/os-reference/sync  — pull latest versions from SOFA feed
// ---------------------------------------------------------------------------
router.post('/apple/os-reference/sync', async (req, res) => {
  try {
    const { syncAppleOsVersions } = require('../services/appleOsSync');
    const result = await syncAppleOsVersions();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// APNS push certificate status
// ---------------------------------------------------------------------------

// Auto-detect the cert replacement date by finding the first day where
// daily enrollment volume spikes significantly above the prior baseline.
async function detectCertDate() {
  // APNS certs are valid for 1 year, so a replacement must be within the last 18 months.
  // Restricting the window avoids false positives from old initial device rollouts.
  const { rows } = await pool.query(`
    WITH daily AS (
      SELECT date_trunc('day', enrolled_at)::date AS d, COUNT(*)::int AS cnt
      FROM integration_devices
      WHERE source = 'mosyle' AND enrolled_at IS NOT NULL
        AND enrolled_at >= NOW() - INTERVAL '18 months'
      GROUP BY 1
    ),
    with_baseline AS (
      SELECT d, cnt,
        COALESCE(AVG(cnt) OVER (ORDER BY d ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING), 0) AS avg_30d
      FROM daily
    )
    SELECT d AS cert_date
    FROM with_baseline
    WHERE cnt >= GREATEST(10, avg_30d * 3)
    ORDER BY CASE WHEN avg_30d > 0 THEN cnt / avg_30d ELSE cnt END DESC
    LIMIT 1
  `);
  return rows[0]?.cert_date || null;
}

router.get('/apple/cert-status', async (req, res) => {
  try {
    const { rows: settingRows } = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('apns_cert_replaced_on','apns_cert_apple_id','apns_old_cert_expires_on')`
    );
    const settings   = Object.fromEntries(settingRows.map(r => [r.key, r.value]));
    const manualDate = settings.apns_cert_replaced_on    || null;
    const appleId    = settings.apns_cert_apple_id       || null;
    const certExpiry = settings.apns_old_cert_expires_on || null;

    let certDate     = manualDate;
    let autoDetected = false;
    if (!certDate) {
      certDate     = await detectCertDate();
      autoDetected = certDate != null;
    }

    // Count how many old-cert device MACs are currently blocked in RADIUS
    const { rows: blockedRows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM radius_devices
       WHERE source = 'mosyle' AND status = 'blocked' AND notes LIKE 'APNS%'`
    );
    const wifiBlockedCount = parseInt(blockedRows[0]?.cnt || 0, 10);

    if (!certDate) {
      return res.json({ certDate: null, autoDetected: false, appleId, certExpiry, summary: null, oldCertDevices: [], wifiBlockedCount });
    }

    const { rows: devices } = await pool.query(`
      SELECT serial_number, device_name, device_model, os_type,
             assigned_email, asset_tag, enrolled_at, apns_cert_ok, synced_at
      FROM integration_devices
      WHERE source = 'mosyle'
        AND os_type IN ('iOS','iPadOS','macOS','tvOS')
      ORDER BY enrolled_at ASC NULLS LAST
    `);

    const summary        = { newCert: { total:0, iOS:0, iPadOS:0, macOS:0, tvOS:0 }, oldCert: { total:0, iOS:0, iPadOS:0, macOS:0, tvOS:0 } };
    const oldCertDevices = [];

    for (const d of devices) {
      // Use the stored apns_cert_ok flag (set by Mosyle sync) when available;
      // fall back to date comparison for devices not yet synced after migration.
      const isNew = d.apns_cert_ok !== null
        ? d.apns_cert_ok
        : (d.enrolled_at && new Date(d.enrolled_at) >= new Date(certDate));
      const bucket = isNew ? summary.newCert : summary.oldCert;
      bucket.total++;
      if (d.os_type === 'iOS')         bucket.iOS++;
      else if (d.os_type === 'iPadOS') bucket.iPadOS++;
      else if (d.os_type === 'macOS')  bucket.macOS++;
      else if (d.os_type === 'tvOS')   bucket.tvOS++;

      if (!isNew) {
        oldCertDevices.push({
          serialNumber: d.serial_number,
          deviceName:   d.device_name,
          deviceModel:  d.device_model,
          osType:       d.os_type,
          assignedEmail: d.assigned_email,
          assetTag:     d.asset_tag,
          enrolledAt:   d.enrolled_at,
          lastSync:     d.synced_at,
        });
      }
    }

    res.json({ certDate, autoDetected, appleId, certExpiry, summary, oldCertDevices, wifiBlockedCount });
  } catch (err) {
    console.error('[fleet] cert-status:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/apple/cert-status/threshold', async (req, res) => {
  try {
    const { certDate, appleId, certExpiry } = req.body;
    if (certDate   && !/^\d{4}-\d{2}-\d{2}$/.test(certDate))   return res.status(400).json({ error: 'Invalid certDate format (YYYY-MM-DD)' });
    if (certExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(certExpiry)) return res.status(400).json({ error: 'Invalid certExpiry format (YYYY-MM-DD)' });

    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('apns_cert_replaced_on',$1,NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [certDate || null]
    );
    if (appleId !== undefined) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('apns_cert_apple_id',$1,NOW())
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
        [appleId || null]
      );
    }
    if (certExpiry !== undefined) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('apns_old_cert_expires_on',$1,NOW())
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
        [certExpiry || null]
      );
    }

    // Recalculate apns_cert_ok for all Mosyle devices whenever the cert date changes.
    if (certDate) {
      await pool.query(
        `UPDATE integration_devices
         SET apns_cert_ok = (enrolled_at IS NOT NULL AND enrolled_at >= $1::timestamptz)
         WHERE source = 'mosyle'`,
        [certDate]
      );
    } else {
      await pool.query(
        `UPDATE integration_devices SET apns_cert_ok = NULL WHERE source = 'mosyle'`
      );
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Import Mosyle "converted devices" CSV to set apns_cert_ok authoritatively.
// Accepts the CSV exported from Mosyle (DeviceUDID in first column).
// Marks matched devices as apns_cert_ok=true, all other Mosyle devices as false.
// ---------------------------------------------------------------------------
router.post('/apple/cert-status/import-csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const text = req.file.buffer.toString('utf8');
    const lines = text.split('\n').slice(1); // skip header row

    const convertedUdids = new Set(
      lines
        .map(l => l.split(',')[0].replace(/"/g, '').trim())
        .filter(Boolean)
    );

    if (convertedUdids.size === 0) {
      return res.status(400).json({ error: 'No UDIDs found in file — check format' });
    }

    // Mark all Mosyle devices false first, then flip the converted ones true.
    await pool.query(
      `UPDATE integration_devices SET apns_cert_ok = false WHERE source = 'mosyle'`
    );

    const { rowCount } = await pool.query(
      `UPDATE integration_devices
       SET apns_cert_ok = true
       WHERE source = 'mosyle'
         AND raw_data->>'deviceudid' = ANY($1::text[])`,
      [Array.from(convertedUdids)]
    );

    // Automatically lift RADIUS blocks for devices now confirmed on the new cert.
    // This lets re-enrolled devices rejoin the main 802.1X network without a
    // separate manual unblock step.
    const { rows: newlyConverted } = await pool.query(
      `SELECT raw_data->>'wifi_mac_address'     as wifi_mac,
              raw_data->>'ethernet_mac_address' as eth_mac
       FROM integration_devices
       WHERE source = 'mosyle' AND apns_cert_ok = true`
    );

    let unblocked = 0;
    for (const d of newlyConverted) {
      const macs = [normaliseMac(d.wifi_mac), normaliseMac(d.eth_mac)].filter(Boolean);
      for (const mac of macs) {
        const { rowCount: ub } = await pool.query(
          `UPDATE radius_devices
           SET status = 'approved', notes = 'Re-enrolled under new APNS certificate', updated_at = NOW()
           WHERE mac_address = $1 AND status = 'blocked' AND notes LIKE 'APNS%'`,
          [mac]
        );
        unblocked += ub;
      }
    }

    const { rows: totals } = await pool.query(
      `SELECT apns_cert_ok, COUNT(*) as cnt
       FROM integration_devices WHERE source='mosyle'
       GROUP BY apns_cert_ok`
    );

    const summary = Object.fromEntries(totals.map(r => [String(r.apns_cert_ok), +r.cnt]));

    res.json({
      ok: true,
      convertedInFile: convertedUdids.size,
      matchedInDb: rowCount,
      newCert: summary['true']  || 0,
      oldCert: summary['false'] || 0,
      unblocked,
    });
  } catch (err) {
    console.error('[fleet] cert-status import-csv:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /fleet/apple/cert-status/detect-stale
// After the old cert expires, any Mosyle device whose last heartbeat predates
// the expiry is definitively on the old cert (Mosyle can no longer push to it).
// Sets apns_cert_ok = false for those devices.
// ---------------------------------------------------------------------------
router.post('/apple/cert-status/detect-stale', async (req, res) => {
  try {
    const { rows: s } = await pool.query(
      `SELECT value FROM settings WHERE key = 'apns_old_cert_expires_on'`
    );
    const expiryDate = s[0]?.value;
    if (!expiryDate) {
      return res.status(400).json({ error: 'Old cert expiry date not set — enter it in Certificate Details first' });
    }

    // Devices whose last beat predates the expiry can no longer receive push — old cert.
    const { rowCount } = await pool.query(
      `UPDATE integration_devices
       SET apns_cert_ok = false
       WHERE source = 'mosyle'
         AND to_timestamp((raw_data->>'date_last_beat')::bigint) < $1::timestamptz
         AND apns_cert_ok IS DISTINCT FROM false`,
      [expiryDate]
    );

    const { rows: totals } = await pool.query(
      `SELECT apns_cert_ok, COUNT(*) as cnt FROM integration_devices
       WHERE source='mosyle' GROUP BY apns_cert_ok`
    );
    const t = Object.fromEntries(totals.map(r => [String(r.apns_cert_ok), +r.cnt]));

    res.json({ ok: true, detected: rowCount, newCert: t['true'] || 0, oldCert: t['false'] || 0 });
  } catch (err) {
    console.error('[fleet] detect-stale:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /fleet/apple/cert-status/block-wifi
// Pushes all old-cert Mosyle device WiFi MACs into radius_devices as 'blocked'.
// Devices already in radius_devices are updated (not duplicated).
// Skips devices with no WiFi MAC address.
// ---------------------------------------------------------------------------
function osTypeToDeviceType(osType) {
  if (osType === 'iPadOS') return 'tablet';
  if (osType === 'macOS')  return 'laptop';
  if (osType === 'iOS')    return 'phone';
  if (osType === 'tvOS')   return 'tv';
  return 'other';
}

function normaliseMac(raw) {
  if (!raw) return null;
  const hex = raw.replace(/[^a-fA-F0-9]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':').toUpperCase();
}

router.post('/apple/cert-status/block-wifi', async (req, res) => {
  try {
    const { rows: devices } = await pool.query(
      `SELECT id, device_name, os_type,
              raw_data->>'wifi_mac_address'     as wifi_mac,
              raw_data->>'ethernet_mac_address' as eth_mac
       FROM integration_devices
       WHERE source = 'mosyle' AND apns_cert_ok = false`
    );

    let blocked = 0, skipped = 0;

    for (const d of devices) {
      const macs = [normaliseMac(d.wifi_mac), normaliseMac(d.eth_mac)].filter(Boolean);
      if (!macs.length) { skipped++; continue; }

      for (const mac of macs) {
        await pool.query(
          `INSERT INTO radius_devices
             (mac_address, device_name, device_type, status, source, source_device_id, notes)
           VALUES ($1,$2,$3,'blocked','mosyle',$4,'APNS certificate expired — re-enrollment required')
           ON CONFLICT (mac_address) DO UPDATE SET
             status = 'blocked',
             notes  = 'APNS certificate expired — re-enrollment required',
             updated_at = NOW()`,
          [mac, d.device_name, osTypeToDeviceType(d.os_type), d.id]
        );
        blocked++;
      }
    }

    res.json({ ok: true, blocked, skipped });
  } catch (err) {
    console.error('[fleet] block-wifi:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /fleet/apple/cert-status/unblock-wifi
// After re-enrollment (apns_cert_ok = true), lift the RADIUS block for those
// devices so they can rejoin the main 802.1X network.
// ---------------------------------------------------------------------------
router.post('/apple/cert-status/unblock-wifi', async (req, res) => {
  try {
    const { rows: devices } = await pool.query(
      `SELECT raw_data->>'wifi_mac_address'     as wifi_mac,
              raw_data->>'ethernet_mac_address' as eth_mac
       FROM integration_devices
       WHERE source = 'mosyle' AND apns_cert_ok = true`
    );

    let unblocked = 0;
    for (const d of devices) {
      const macs = [normaliseMac(d.wifi_mac), normaliseMac(d.eth_mac)].filter(Boolean);
      for (const mac of macs) {
        const { rowCount } = await pool.query(
          `UPDATE radius_devices
           SET status = 'approved', notes = 'Re-enrolled under new APNS certificate', updated_at = NOW()
           WHERE mac_address = $1 AND status = 'blocked' AND notes LIKE 'APNS%'`,
          [mac]
        );
        unblocked += rowCount;
      }
    }

    res.json({ ok: true, unblocked });
  } catch (err) {
    console.error('[fleet] unblock-wifi:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// AUP reference CRUD
// ---------------------------------------------------------------------------
router.get('/chromebooks/aup-reference', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM chromebook_aup_reference ORDER BY model`);
  res.json(rows);
});

router.post('/chromebooks/aup-reference', async (req, res) => {
  const { model, aup_date, notes } = req.body;
  if (!model) return res.status(400).json({ error: 'model required' });
  const { rows: [row] } = await pool.query(
    `INSERT INTO chromebook_aup_reference (model, aup_date, notes)
     VALUES ($1,$2,$3)
     ON CONFLICT (model) DO UPDATE SET aup_date=$2, notes=$3, updated_at=NOW()
     RETURNING *`,
    [model, aup_date || null, notes || null]
  );
  res.status(201).json(row);
});

router.delete('/chromebooks/aup-reference/:id', async (req, res) => {
  await pool.query(`DELETE FROM chromebook_aup_reference WHERE id=$1`, [req.params.id]);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Cross-sync
// ---------------------------------------------------------------------------
router.get('/cross-sync/gaps', async (req, res) => {
  const gaps = await fleetSync.getGaps();
  res.json(gaps);
});

router.get('/cross-sync/settings', async (req, res) => {
  const cfg = await fleetSync.getFleetSettings();
  let modelName = null, statusName = null;
  if (cfg.defaultModelId || cfg.defaultStatusId) {
    try {
      if (cfg.defaultModelId) {
        const models = await snipeit.listModels();
        modelName = models.find(m => m.id === cfg.defaultModelId)?.name || null;
      }
      if (cfg.defaultStatusId) {
        const statuses = await snipeit.listStatusLabels();
        statusName = statuses.find(s => s.id === cfg.defaultStatusId)?.name || null;
      }
    } catch { /* Snipe-IT might not be reachable */ }
  }
  res.json({ ...cfg, defaultModelName: modelName, defaultStatusName: statusName });
});

router.post('/cross-sync/settings', async (req, res) => {
  await fleetSync.setFleetSettings(req.body);
  res.json({ ok: true });
});

router.post('/cross-sync/run', async (req, res) => {
  // Return immediately — sync runs in background and logs to fleet_sync_log.
  // Client polls GET /cross-sync/history for the result.
  res.json({ status: 'started' });
  fleetSync.runCrossSync(req.user.userId).catch(err => {
    console.error('[fleet] cross-sync background error:', err.message);
  });
});

router.get('/cross-sync/history', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT fsl.*, u.full_name AS triggered_by_name
     FROM fleet_sync_log fsl
     LEFT JOIN users u ON u.id = fsl.triggered_by
     ORDER BY run_at DESC LIMIT 20`
  );
  res.json(rows);
});

router.get('/cross-sync/snipeit-models', async (req, res) => {
  try {
    const models = await snipeit.listModels({ search: req.query.q });
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/cross-sync/snipeit-statuses', async (req, res) => {
  try {
    const statuses = await snipeit.listStatusLabels();
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /fleet/offline
// ---------------------------------------------------------------------------
router.get('/offline', async (req, res) => {
  const days   = Math.min(parseInt(req.query.days) || 30, 365);
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const unified = await deviceConsolidation.getUnifiedDevices();

  const result = unified
    .map(d => {
      const lastSeen = d.network?.lastSeen || d.lastSynced;
      const daysSince = lastSeen
        ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 86_400_000)
        : null;
      return { ...d, lastSeen, daysSince };
    })
    .filter(d => !d.lastSeen || new Date(d.lastSeen) < cutoff)
    .map(d => ({
      serialNumber:  d.serialNumber,
      deviceName:    d.deviceName,
      deviceModel:   d.deviceModel,
      osType:        d.osType,
      assignedEmail: d.assignedEmail,
      assetTag:      d.assetTag,
      lastSeen:      d.lastSeen,
      daysSince:     d.daysSince,
      sources:       d.sources.map(s => s.source),
    }))
    .sort((a, b) => (b.daysSince ?? 99999) - (a.daysSince ?? 99999));

  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /fleet/lifecycle
// ---------------------------------------------------------------------------
router.get('/lifecycle', async (req, res) => {
  const [{ rows: chromebookRows }, { rows: aupRef }, { rows: snipeRows }] = await Promise.all([
    pool.query(
      `SELECT serial_number, device_name, device_model, os_type, assigned_email, asset_tag, source
       FROM integration_devices WHERE serial_number IS NOT NULL`
    ),
    pool.query(`SELECT model, aup_date FROM chromebook_aup_reference`),
    // Pull purchase/warranty from Snipe-IT raw_data custom fields
    pool.query(
      `SELECT serial_number, raw_data FROM integration_devices WHERE source='snipeit'`
    ),
  ]);

  const aupMap = Object.fromEntries(aupRef.map(r => [r.model?.toLowerCase(), r.aup_date]));

  // Extract purchase/warranty from Snipe-IT custom fields if present
  const warrantyBySerial = new Map();
  for (const r of snipeRows) {
    if (!r.serial_number || !r.raw_data) continue;
    const raw   = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
    const cf    = raw?.custom_fields || {};
    // Common field names for purchase/warranty dates
    const purchaseDate  = Object.values(cf).find(f => /purchase.*date|bought|acquired/i.test(f.field || ''))?.value || null;
    const warrantyDate  = Object.values(cf).find(f => /warrant|eol|end.*of.*life/i.test(f.field || ''))?.value || null;
    if (purchaseDate || warrantyDate) {
      warrantyBySerial.set(r.serial_number.trim().toUpperCase(), { purchaseDate, warrantyExpires: warrantyDate });
    }
  }

  // Group by serial
  const bySerial = new Map();
  for (const r of chromebookRows) {
    const s = r.serial_number?.trim().toUpperCase() || `__id__${r.source}`;
    if (!bySerial.has(s)) bySerial.set(s, []);
    bySerial.get(s).push(r);
  }

  const result = [];
  for (const [serial, rows] of bySerial) {
    const ref      = rows.find(r => r.source === 'mosyle') ||
                     rows.find(r => r.source === 'google_admin') ||
                     rows[0];
    const model    = ref.device_model;
    const aupDate  = model ? aupMap[model?.toLowerCase()] : null;
    const warranty = warrantyBySerial.get(serial) || {};

    let warrantyStatus = 'none';
    if (warranty.warrantyExpires) {
      warrantyStatus = new Date(warranty.warrantyExpires) < new Date() ? 'expired' : 'ok';
    }

    result.push({
      serialNumber:    serial,
      deviceName:      ref.device_name,
      deviceModel:     model,
      osType:          ref.os_type,
      assignedEmail:   rows.find(r => r.assigned_email)?.assigned_email || null,
      assetTag:        rows.find(r => r.asset_tag)?.asset_tag || null,
      aupDate:         aupDate || null,
      aupStatus:       aupStatus(aupDate),
      purchaseDate:    warranty.purchaseDate || null,
      warrantyExpires: warranty.warrantyExpires || null,
      warrantyStatus,
      sources:         [...new Set(rows.map(r => r.source))],
    });
  }

  // Sort: expired AUP or warranty first
  result.sort((a, b) => {
    const urgencyScore = (d) => {
      let s = 0;
      if (d.warrantyStatus === 'expired') s += 10;
      if (d.aupStatus === 'expired')      s += 8;
      if (d.aupStatus === 'expiring')     s += 4;
      return s;
    };
    return urgencyScore(b) - urgencyScore(a);
  });

  res.json(result);
});

module.exports = router;
