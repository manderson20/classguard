const { pool } = require('../db');
const snipeit  = require('./snipeit');
const google   = require('./google');

// ---------------------------------------------------------------------------
// Fleet cross-sync — finds devices in MDMs not yet in Snipe-IT, creates them,
// then writes the assigned asset_tag back to Google Admin (annotatedAssetId).
// Mosyle Manager API v2 has no public endpoint for writing asset IDs, so for
// Mosyle devices we record the asset_tag locally in integration_devices only.
// ---------------------------------------------------------------------------

async function getFleetSettings() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('fleet_default_snipeit_model_id','fleet_default_snipeit_status_id')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    defaultModelId:  parseInt(cfg.fleet_default_snipeit_model_id)  || null,
    defaultStatusId: parseInt(cfg.fleet_default_snipeit_status_id) || null,
  };
}

async function setFleetSettings({ defaultModelId, defaultStatusId }) {
  const pairs = [
    ['fleet_default_snipeit_model_id',  defaultModelId  ?? null],
    ['fleet_default_snipeit_status_id', defaultStatusId ?? null],
  ];
  for (const [key, value] of pairs) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value === null ? null : String(value)]
    );
  }
}

// Best-effort model search in Snipe-IT: try the device model name, fall back
// to the configured default. Returns null if neither is available.
async function resolveModelId(http, deviceModel, defaultModelId) {
  if (deviceModel) {
    try {
      const models = await snipeit.listModels({ search: deviceModel });
      if (models.length > 0) return models[0].id;
    } catch { /* fall through to default */ }
  }
  return defaultModelId || null;
}

// ---------------------------------------------------------------------------
// Compute gap list (devices in MDM but missing from Snipe-IT, or present in
// Snipe-IT but asset tag not yet written back to an MDM source).
// ---------------------------------------------------------------------------
async function getGaps() {
  const { rows } = await pool.query(
    `SELECT id, source, external_id, serial_number, device_name, device_model,
            os_type, assigned_email, asset_tag
     FROM integration_devices
     WHERE serial_number IS NOT NULL AND serial_number != ''`
  );

  const bySerial = new Map();
  for (const d of rows) {
    const s = d.serial_number.trim().toUpperCase();
    if (!bySerial.has(s)) bySerial.set(s, []);
    bySerial.get(s).push(d);
  }

  const gaps = [];
  for (const [serial, deviceRows] of bySerial) {
    const sources  = deviceRows.map(r => r.source);
    const hasSnipe = sources.includes('snipeit');
    const hasMDM   = sources.some(s => s !== 'snipeit');
    if (!hasMDM) continue; // Snipe-IT only — not our concern here

    const ref = deviceRows.find(r => r.source === 'mosyle') ||
                deviceRows.find(r => r.source === 'google_admin') ||
                deviceRows[0];

    if (!hasSnipe) {
      gaps.push({
        serial,
        deviceName:  ref.device_name,
        deviceModel: ref.device_model,
        osType:      ref.os_type,
        presentIn:   sources,
        missingFrom: ['snipeit'],
        writebackNeeded: [],
        assetTag:    null,
      });
      continue;
    }

    // In Snipe-IT — check if asset tag needs writing back to MDM sources
    const snipeRow = deviceRows.find(r => r.source === 'snipeit');
    if (!snipeRow?.asset_tag) continue;

    const writebackNeeded = deviceRows
      .filter(r => r.source !== 'snipeit' && !r.asset_tag)
      .map(r => r.source);

    if (writebackNeeded.length > 0) {
      gaps.push({
        serial,
        deviceName:  ref.device_name,
        deviceModel: ref.device_model,
        osType:      ref.os_type,
        presentIn:   sources,
        missingFrom: [],
        writebackNeeded,
        assetTag:    snipeRow.asset_tag,
      });
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Run the cross-sync: create missing Snipe-IT assets + write back asset tags.
// ---------------------------------------------------------------------------
async function runCrossSync(actorId) {
  const cfg = await getFleetSettings();
  const { rows: [cs] } = await pool.query(`SELECT value FROM settings WHERE key = 'google_customer_id'`);
  const customerId = cs?.value || 'my_customer';

  let http;
  try {
    http = await snipeit.getClient();
  } catch (err) {
    throw new Error(`Snipe-IT not reachable: ${err.message}`, { cause: err });
  }

  const { rows: allDevices } = await pool.query(
    `SELECT id, source, external_id, serial_number, device_name, device_model,
            os_type, assigned_email, asset_tag
     FROM integration_devices
     WHERE serial_number IS NOT NULL AND serial_number != ''`
  );

  const bySerial = new Map();
  for (const d of allDevices) {
    const s = d.serial_number.trim().toUpperCase();
    if (!bySerial.has(s)) bySerial.set(s, []);
    bySerial.get(s).push(d);
  }

  const results = { createdInSnipeit: 0, wroteBackToGoogle: 0, wroteBackToMosyle: 0, skipped: 0, errors: [] };

  for (const [serial, deviceRows] of bySerial) {
    const snipeRow  = deviceRows.find(r => r.source === 'snipeit');
    const googleRow = deviceRows.find(r => r.source === 'google_admin');
    const mosyleRow = deviceRows.find(r => r.source === 'mosyle');

    if (!snipeRow) {
      // Not in Snipe-IT — create it
      if (!cfg.defaultModelId) {
        results.errors.push(`${serial}: skipped — no default Snipe-IT model configured`);
        results.skipped++;
        continue;
      }

      const ref     = mosyleRow || googleRow || deviceRows[0];
      const modelId = await resolveModelId(http, ref.device_model, cfg.defaultModelId);
      if (!modelId) { results.skipped++; continue; }

      try {
        const created = await snipeit.createAsset({
          name:     ref.device_name,
          serial,
          modelId,
          statusId: cfg.defaultStatusId || 1,
        });

        const assetTag = created?.asset_tag;
        results.createdInSnipeit++;

        if (assetTag) {
          // Record asset tag on MDM source rows
          for (const r of deviceRows.filter(r => r.source !== 'snipeit')) {
            await pool.query(`UPDATE integration_devices SET asset_tag=$1 WHERE id=$2`, [assetTag, r.id]);
          }

          // Write back to Google Admin if it's a Chromebook
          if (googleRow) {
            try {
              await google.updateChromebookAssetId(googleRow.external_id, assetTag);
              results.wroteBackToGoogle++;
            } catch (err) {
              results.errors.push(`${serial} Google writeback: ${err.message}`);
            }
          }

          // Mosyle: update local record only (API doesn't support direct writeback)
          if (mosyleRow) results.wroteBackToMosyle++;
        }
      } catch (err) {
        results.errors.push(`${serial} create in Snipe-IT: ${err.message}`);
      }
      continue;
    }

    // Already in Snipe-IT — check writeback
    const assetTag = snipeRow.asset_tag;
    if (!assetTag) { results.skipped++; continue; }

    if (googleRow && !googleRow.asset_tag) {
      try {
        await google.updateChromebookAssetId(googleRow.external_id, assetTag);
        await pool.query(`UPDATE integration_devices SET asset_tag=$1 WHERE id=$2`, [assetTag, googleRow.id]);
        results.wroteBackToGoogle++;
      } catch (err) {
        results.errors.push(`${serial} Google writeback: ${err.message}`);
      }
    }

    if (mosyleRow && !mosyleRow.asset_tag) {
      await pool.query(`UPDATE integration_devices SET asset_tag=$1 WHERE id=$2`, [assetTag, mosyleRow.id]);
      results.wroteBackToMosyle++;
    }
  }

  await pool.query(
    `INSERT INTO fleet_sync_log
       (created_in_snipeit, wrote_back_to_mosyle, wrote_back_to_google, skipped, errors, triggered_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [results.createdInSnipeit, results.wroteBackToMosyle, results.wroteBackToGoogle,
     results.skipped, results.errors, actorId || null]
  );

  return results;
}

module.exports = { getFleetSettings, setFleetSettings, getGaps, runCrossSync };
