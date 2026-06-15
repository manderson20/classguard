/**
 * Sync approved devices into radius_devices from multiple MDM/asset sources.
 * Each source is tracked independently in radius_device_sources so that:
 *
 *   1. A device can appear in multiple sources (Snipe-IT + Mosyle + Google Admin)
 *      and the UI shows all of them simultaneously.
 *
 *   2. When a device is removed from a source (e.g. student MacBook removed from
 *      Mosyle after lease-to-own graduation), that source row is marked inactive
 *      and removed_at is recorded.
 *
 *   3. If a device has NO remaining active sources after a sync, its status is
 *      changed from 'approved' → 'pending' so an admin must explicitly re-approve
 *      or block it. Status is never auto-changed to 'blocked' — that remains
 *      an intentional admin action.
 *
 * Status promotion rules (applied per upsert):
 *   - New device from MDM                       → 'approved'
 *   - Device already 'blocked'                  → stays 'blocked' (MDM sync never overrides)
 *   - Device 'pending', now seen in MDM         → 'approved'
 *   - Device 'approved', removed from all MDMs  → 'pending' (needs admin review)
 */

const { pool }   = require('../db');
const axios      = require('axios');
const { google } = require('googleapis');

// ---------------------------------------------------------------------------
// Normalise MAC to XX:XX:XX:XX:XX:XX uppercase
// ---------------------------------------------------------------------------
function normaliseMac(raw) {
  if (!raw) return null;
  const clean = raw.replace(/[^a-fA-F0-9]/g, '');
  if (clean.length !== 12) return null;
  return clean.match(/.{2}/g).join(':').toUpperCase();
}

async function getSettings(keys) {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [keys]
  );
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ---------------------------------------------------------------------------
// Core upsert: device row + source association row
// Returns the radius_devices.id
// ---------------------------------------------------------------------------
async function upsertDeviceWithSource({
  mac, name, type, source, sourceDeviceId, sourceExtra = null,
}) {
  const normMac = normaliseMac(mac);
  if (!normMac) return null;

  // Upsert the device itself
  const { rows: devRows } = await pool.query(
    `INSERT INTO radius_devices
       (mac_address, device_name, device_type, source, source_device_id, status)
     VALUES ($1,$2,$3,$4,$5,'approved')
     ON CONFLICT (mac_address) DO UPDATE SET
       device_name      = COALESCE(EXCLUDED.device_name, radius_devices.device_name),
       device_type      = COALESCE(EXCLUDED.device_type, radius_devices.device_type),
       source_device_id = COALESCE(EXCLUDED.source_device_id, radius_devices.source_device_id),
       -- Promote pending → approved when seen in MDM; never touch 'blocked'
       status = CASE
         WHEN radius_devices.status = 'pending'  THEN 'approved'
         WHEN radius_devices.status = 'blocked'  THEN 'blocked'
         ELSE radius_devices.status
       END,
       updated_at = NOW()
     RETURNING id`,
    [normMac, name || null, type || 'other', source, sourceDeviceId || null]
  );

  const deviceId = devRows[0]?.id;
  if (!deviceId) return null;

  // Upsert the source association
  await pool.query(
    `INSERT INTO radius_device_sources
       (device_id, source, source_device_id, source_name, source_extra, is_active, last_synced_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,true,NOW())
     ON CONFLICT (device_id, source) DO UPDATE SET
       source_device_id = COALESCE(EXCLUDED.source_device_id, radius_device_sources.source_device_id),
       source_name      = COALESCE(EXCLUDED.source_name, radius_device_sources.source_name),
       source_extra     = COALESCE(EXCLUDED.source_extra, radius_device_sources.source_extra),
       is_active        = true,
       last_synced_at   = NOW(),
       removed_at       = NULL`,
    [deviceId, source, sourceDeviceId || null, name || null,
     sourceExtra ? JSON.stringify(sourceExtra) : null]
  );

  return deviceId;
}

// ---------------------------------------------------------------------------
// Deprovision: after syncing a source, mark any device that was active in that
// source but NOT in the current sync as removed. If it has no remaining active
// sources, demote to 'pending' for admin review.
// ---------------------------------------------------------------------------
async function deprovisionRemovedDevices(sourceName, seenDeviceIds) {
  if (!seenDeviceIds.length) return 0;

  // Mark source rows inactive for devices not seen in this sync
  const { rows: stale } = await pool.query(
    `UPDATE radius_device_sources
     SET is_active = false, removed_at = NOW()
     WHERE source = $1
       AND is_active = true
       AND device_id <> ALL($2::uuid[])
     RETURNING device_id`,
    [sourceName, seenDeviceIds]
  );

  let demoted = 0;
  for (const { device_id } of stale) {
    // Check if this device still has any active MDM source
    const { rows: activeSrc } = await pool.query(
      `SELECT COUNT(*) FROM radius_device_sources
       WHERE device_id = $1 AND is_active = true
         AND source <> 'radius_seen'`,   // radius_seen doesn't count as MDM
      [device_id]
    );

    if (parseInt(activeSrc[0].count) === 0) {
      // No active MDM source — move to pending, append note
      await pool.query(
        `UPDATE radius_devices SET
           status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'pending' END,
           notes  = CASE
             WHEN notes IS NOT NULL
               THEN notes || E'\\n[' || NOW()::date || '] Removed from ' || $2 || ' — pending review'
             ELSE '[' || NOW()::date || '] Removed from ' || $2 || ' — pending review'
           END,
           updated_at = NOW()
         WHERE id = $1 AND status <> 'blocked'`,
        [device_id, sourceName]
      );
      demoted++;
    }
  }

  return stale.length;
}

// ---------------------------------------------------------------------------
// Mosyle — all managed iOS + macOS devices
// ---------------------------------------------------------------------------
async function syncMosyle() {
  const cfg = await getSettings(['mosyle_access_token']);
  if (!cfg.mosyle_access_token) return { synced: 0, removed: 0, source: 'mosyle', skipped: true };

  let page = 1, seenIds = [];

  while (true) {
    const res = await axios.post(
      'https://managerapi.mosyle.com/v2/listdevices',
      new URLSearchParams({
        accessToken: cfg.mosyle_access_token,
        os:          'ios,macos',
        page:        String(page),
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const devices = res.data?.response?.devices || [];
    if (!devices.length) break;

    for (const d of devices) {
      const mac = d.wifi_mac_address || d.mac_address;
      const isIpad = /ipad|iphone/i.test(d.os_type || '');
      const id = await upsertDeviceWithSource({
        mac,
        name:           d.device_name || d.serial_number,
        type:           isIpad ? 'tablet' : 'laptop',
        source:         'mosyle',
        sourceDeviceId: d.serial_number || d.udid,
        sourceExtra:    { serial: d.serial_number, os: d.os_type, model: d.model,
                          assigned_user: d.assigned_user_email || null },
      });
      if (id) seenIds.push(id);
    }

    if (devices.length < 50) break;
    page++;
  }

  const removed = await deprovisionRemovedDevices('mosyle', seenIds);
  return { synced: seenIds.length, removed, source: 'mosyle' };
}

// ---------------------------------------------------------------------------
// Snipe-IT — all tracked assets with MAC addresses
// ---------------------------------------------------------------------------
async function syncSnipeIt() {
  const cfg = await getSettings(['snipeit_url','snipeit_token']);
  if (!cfg.snipeit_url || !cfg.snipeit_token) return { synced: 0, removed: 0, source: 'snipeit', skipped: true };

  let offset = 0, seenIds = [];
  const limit = 500;

  while (true) {
    const res = await axios.get(`${cfg.snipeit_url.replace(/\/$/, '')}/api/v1/hardware`, {
      headers: { Authorization: `Bearer ${cfg.snipeit_token}`, Accept: 'application/json' },
      params:  { limit, offset },
    });

    const rows = res.data?.rows || [];
    if (!rows.length) break;

    for (const asset of rows) {
      const customMac = Object.values(asset.custom_fields || {})
        .find(f => /mac/i.test(f.field || '') && f.value)?.value;
      const mac = asset.mac_address || customMac;
      if (!normaliseMac(mac)) { offset++; continue; }

      const cat   = (asset.category?.name || '').toLowerCase();
      let   type  = 'other';
      if (/laptop|macbook|notebook/i.test(cat))  type = 'laptop';
      else if (/desktop|imac|mac mini/i.test(cat)) type = 'desktop';
      else if (/ipad|tablet/i.test(cat))          type = 'tablet';
      else if (/phone/i.test(cat))                type = 'phone';
      else if (/printer/i.test(cat))              type = 'printer';
      else if (/switch/i.test(cat))               type = 'switch';
      else if (/ap|access point/i.test(cat))      type = 'ap';
      else if (/tv|display/i.test(cat))           type = 'tv';
      else if (/server/i.test(cat))               type = 'server';
      else if (/chromebook/i.test(cat))           type = 'chromebook';

      const id = await upsertDeviceWithSource({
        mac,
        name:           asset.name || asset.asset_tag,
        type,
        source:         'snipeit',
        sourceDeviceId: String(asset.id),
        sourceExtra:    { asset_tag: asset.asset_tag, category: asset.category?.name,
                          serial: asset.serial, model: asset.model?.name,
                          assigned_to: asset.assigned_to?.name || null,
                          status_label: asset.status_label?.name || null },
      });
      if (id) seenIds.push(id);
    }

    if (rows.length < limit) break;
    offset += limit;
  }

  const removed = await deprovisionRemovedDevices('snipeit', seenIds);
  return { synced: seenIds.length, removed, source: 'snipeit' };
}

// ---------------------------------------------------------------------------
// Google Admin — ChromeOS + Android Enterprise devices
// ---------------------------------------------------------------------------
async function syncGoogleAdmin() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) return { synced: 0, removed: 0, source: 'google_admin', skipped: true };

  const keyFile = require(keyPath);
  const auth = new google.auth.JWT({
    email:   keyFile.client_email,
    key:     keyFile.private_key,
    scopes:  ['https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly',
              'https://www.googleapis.com/auth/admin.directory.device.mobile.readonly'],
    subject: process.env.SUPERADMIN_EMAIL,
  });

  const admin = google.admin({ version: 'directory_v1', auth });
  let seenIds = [], pageToken;

  do {
    const res = await admin.chromeosdevices.list({
      customerId: 'my_customer',
      maxResults: 200,
      pageToken,
      projection: 'BASIC',
    });
    pageToken = res.data.nextPageToken;
    for (const d of res.data.chromeosdevices || []) {
      const id = await upsertDeviceWithSource({
        mac:            d.macAddress || d.ethernetMacAddress,
        name:           d.annotatedAssetId || d.annotatedUser || d.deviceId,
        type:           'chromebook',
        source:         'google_admin',
        sourceDeviceId: d.deviceId,
        sourceExtra:    { serial: d.serialNumber, model: d.model,
                          annotated_user: d.annotatedUser, ou: d.orgUnitPath,
                          os_version: d.osVersion, status: d.status },
      });
      if (id) seenIds.push(id);
    }
  } while (pageToken);

  const removed = await deprovisionRemovedDevices('google_admin', seenIds);
  return { synced: seenIds.length, removed, source: 'google_admin' };
}

// ---------------------------------------------------------------------------
// Network controllers — MACs already in network_clients arrive as 'pending'
// (not auto-approved; admin reviews). No deprovisioning run for this source
// since network_clients reflects real-time presence, not ownership.
// ---------------------------------------------------------------------------
async function syncNetworkControllers() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (mac) mac::text, hostname, connection_type
     FROM network_clients WHERE mac IS NOT NULL
     ORDER BY mac, last_seen DESC`
  );

  let synced = 0;
  for (const r of rows) {
    const mac = normaliseMac(r.mac);
    if (!mac) continue;

    // Insert as pending — don't call upsertDeviceWithSource because we
    // don't want to promote pending→approved for network-seen devices
    const { rows: devRows } = await pool.query(
      `INSERT INTO radius_devices (mac_address, source, status, device_name)
       VALUES ($1,'network_controller','pending',$2)
       ON CONFLICT (mac_address) DO UPDATE SET
         last_seen = NOW(), updated_at = NOW()
       RETURNING id`,
      [mac, r.hostname || null]
    );

    const deviceId = devRows[0]?.id;
    if (deviceId) {
      await pool.query(
        `INSERT INTO radius_device_sources (device_id, source, source_name, is_active, last_synced_at)
         VALUES ($1,'network_controller',$2,true,NOW())
         ON CONFLICT (device_id, source) DO UPDATE SET
           is_active = true, last_synced_at = NOW()`,
        [deviceId, r.hostname || null]
      );
      synced++;
    }
  }
  return { synced, removed: 0, source: 'network_controller' };
}

// ---------------------------------------------------------------------------
// Master sync
// ---------------------------------------------------------------------------
async function syncAllSources(onProgress = () => {}) {
  const results = [];

  onProgress('Syncing Mosyle…');
  results.push(await syncMosyle().catch(e => ({ source: 'mosyle', error: e.message })));

  onProgress('Syncing Snipe-IT…');
  results.push(await syncSnipeIt().catch(e => ({ source: 'snipeit', error: e.message })));

  onProgress('Syncing Google Admin…');
  results.push(await syncGoogleAdmin().catch(e => ({ source: 'google_admin', error: e.message })));

  onProgress('Syncing network controllers…');
  results.push(await syncNetworkControllers().catch(e => ({ source: 'network_controller', error: e.message })));

  onProgress('Done');
  return results;
}

module.exports = {
  syncAllSources, syncMosyle, syncSnipeIt, syncGoogleAdmin, syncNetworkControllers,
  normaliseMac,
};
