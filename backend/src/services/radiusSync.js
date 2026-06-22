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
// Device source → device_type derivation. integration_devices.os_type holds
// different semantics per source (the actual OS for Mosyle, the Snipe-IT
// asset category name for Snipe-IT) — both are matched against here so one
// function covers all three MDM sources.
// ---------------------------------------------------------------------------
function deriveDeviceType(source, osType) {
  const v = (osType || '').toLowerCase();
  if (source === 'google_admin') return 'chromebook';
  if (source === 'mosyle') {
    if (/tvos|appletv/.test(v)) return 'tv';
    if (/ipad|iphone/.test(v))  return 'tablet';
    return 'laptop';
  }
  if (source === 'snipeit') {
    if (/laptop|macbook|notebook/.test(v))  return 'laptop';
    if (/desktop|imac|mac mini/.test(v))    return 'desktop';
    if (/ipad|tablet/.test(v))              return 'tablet';
    if (/phone/.test(v))                    return 'phone';
    if (/printer/.test(v))                  return 'printer';
    if (/switch/.test(v))                   return 'switch';
    if (/ap|access point/.test(v))          return 'ap';
    if (/tv|display/.test(v))               return 'tv';
    if (/server/.test(v))                   return 'server';
    if (/chromebook/.test(v))               return 'chromebook';
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Shared device-list source: reads integration_devices (already populated
// by mosyle.syncDevices() / snipeit.syncAssets() / google.syncDevices() —
// the same canonical sync the Integrations page uses) instead of calling
// each vendor's API a second time with its own copy of the field-mapping
// logic. Keeps RADIUS's device list guaranteed consistent with what
// Integrations shows, and means there's only one place per vendor that
// needs to know how to read its API response at all.
// ---------------------------------------------------------------------------
async function syncFromIntegrationDevices(source) {
  const { rows } = await pool.query(
    `SELECT external_id, serial_number, mac_addresses, device_name, device_model,
            os_type, assigned_email
     FROM integration_devices WHERE source = $1`,
    [source]
  );

  if (rows.length === 0) {
    return { synced: 0, removed: 0, source, skipped: true };
  }

  let seenIds = [], skippedNoMac = 0;

  for (const d of rows) {
    const mac = (d.mac_addresses || []).map(normaliseMac).find(Boolean);
    if (!mac) { skippedNoMac++; continue; }

    const id = await upsertDeviceWithSource({
      mac,
      name:           d.device_name || d.serial_number,
      type:           deriveDeviceType(source, d.os_type),
      source,
      sourceDeviceId: d.serial_number || d.external_id,
      sourceExtra:    { serial: d.serial_number, model: d.device_model,
                        os: d.os_type, assigned_email: d.assigned_email },
    });
    if (id) seenIds.push(id);
  }

  const removed = await deprovisionRemovedDevices(source, seenIds);
  return { synced: seenIds.length, removed, skippedNoMac, source };
}

// ---------------------------------------------------------------------------
// Mosyle — all managed iOS + macOS devices
// ---------------------------------------------------------------------------
async function syncMosyle() {
  const mosyle = require('./mosyle');
  const cfg    = await mosyle.getConfig();
  if (!cfg.token) return { synced: 0, removed: 0, source: 'mosyle', skipped: true };

  await mosyle.syncDevices(); // refresh integration_devices first
  return syncFromIntegrationDevices('mosyle');
}

// ---------------------------------------------------------------------------
// Snipe-IT — all tracked assets with MAC addresses
// ---------------------------------------------------------------------------
async function syncSnipeIt() {
  const cfg = await getSettings(['snipeit_url','snipeit_token']);
  if (!cfg.snipeit_url || !cfg.snipeit_token) return { synced: 0, removed: 0, source: 'snipeit', skipped: true };

  const snipeit = require('./snipeit');
  await snipeit.syncAssets();
  return syncFromIntegrationDevices('snipeit');
}

// ---------------------------------------------------------------------------
// Google Admin — ChromeOS devices, the district's own school-owned
// Chromebooks. These are the devices that should actually be allowed onto
// the 802.1X SSID via MAB; AP/switch infrastructure is handled entirely
// separately by syncNasFromControllers() below.
// ---------------------------------------------------------------------------
async function syncGoogleAdmin() {
  const google = require('./google');
  try {
    await google.syncDevices(); // refresh integration_devices first
  } catch (err) {
    return { synced: 0, removed: 0, source: 'google_admin', skipped: true, error: err.message };
  }
  return syncFromIntegrationDevices('google_admin');
}

// ---------------------------------------------------------------------------
// NAS auto-provisioning — APs/switches/gateways learned from a network
// controller (currently UniFi) become radius_nas rows automatically, so they
// don't need to be added by hand one at a time. All auto-discovered NAS
// entries from a given vendor share ONE shared secret (radius_default_nas_secret),
// matching how UniFi's RADIUS Profile feature actually works — one profile
// with one secret gets applied to every AP/switch in the site, rather than a
// secret per device. Existing rows never have their shared_secret touched by
// a sync — only an admin edit (or first creation) sets it, so a manually
// customised secret on a given NAS is never silently overwritten.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

async function getOrCreateDefaultNasSecret() {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'radius_default_nas_secret'`);
  if (rows[0]?.value) return rows[0].value;

  const secret = crypto.randomBytes(24).toString('base64url');
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('radius_default_nas_secret', $1, NOW())
     ON CONFLICT (key) DO NOTHING`,
    [secret]
  );
  // Re-read in case of a concurrent insert race — always use whatever ended up stored.
  const { rows: final } = await pool.query(`SELECT value FROM settings WHERE key = 'radius_default_nas_secret'`);
  return final[0].value;
}

const NAS_TYPE_LABEL = { uap: 'Access Point', usw: 'Switch', uxg: 'Gateway', ugw: 'Gateway' };

async function syncNasFromControllers() {
  const { getAdapter } = require('./network');
  const { rows: controllers } = await pool.query(
    `SELECT * FROM network_controllers WHERE is_active = true`
  );

  let synced = 0;
  const errors = [];

  for (const controller of controllers) {
    const adapter = getAdapter(controller.vendor);
    if (!adapter.fetchDevices) continue; // vendor doesn't support infra-device discovery yet

    let devices;
    try {
      devices = await adapter.fetchDevices(controller);
    } catch (e) {
      errors.push(`${controller.name}: ${e.message}`);
      continue;
    }

    const secret = await getOrCreateDefaultNasSecret();

    for (const d of devices) {
      const shortname = (d.name || d.mac).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
      const label      = NAS_TYPE_LABEL[d.type] || d.type;
      await pool.query(
        `INSERT INTO radius_nas (name, shortname, ip_address, shared_secret, vendor, description, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (ip_address) DO UPDATE SET
           name        = EXCLUDED.name,
           description = EXCLUDED.description,
           is_active   = EXCLUDED.is_active,
           updated_at  = NOW()`,
        [d.name, shortname, d.ip, secret, controller.vendor,
         `Auto-discovered ${label}${d.model ? ` (${d.model})` : ''} from ${controller.name}`, d.isOnline]
      );
      synced++;
    }
  }

  return { synced, errors, source: 'network_infrastructure' };
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

  // Network controllers (APs/switches) are NOT a client-device source —
  // intentionally not synced into radius_devices at all. They're only used
  // below to auto-provision the APs/switches themselves as RADIUS NAS
  // clients, never as MAB-approved end-user devices.
  onProgress('Syncing NAS infrastructure (APs/switches)…');
  results.push(await syncNasFromControllers().catch(e => ({ source: 'network_infrastructure', error: e.message })));

  onProgress('Done');
  return results;
}

module.exports = {
  syncAllSources, syncMosyle, syncSnipeIt, syncGoogleAdmin,
  syncNasFromControllers, normaliseMac,
};
