const axios  = require('axios');
const { pool } = require('../db');

const MOSYLE_API = 'https://businessapi.mosyle.com/v1';

async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('mosyle_access_token')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { token: process.env.MOSYLE_ACCESS_TOKEN || cfg.mosyle_access_token || null };
}

// Since Feb 2024 Mosyle requires the access token to be a JWT sent via
// "Authorization: Bearer", not the old accesstoken form-param style this
// used to use. A token with no dots isn't JWT-shaped at all — almost
// certainly copied from the wrong place (e.g. an old Manager API key) —
// so fail fast with a specific message instead of a generic 401 from Mosyle.
function assertJwtShaped(token) {
  if (token.split('.').length !== 3) {
    throw new Error(
      'Mosyle access token doesn\'t look like a JWT. Since Feb 2024 Mosyle requires a JWT access ' +
      'token generated from Organization → API Integration → Add new token in the Mosyle Business console.'
    );
  }
}

async function apiRequest(endpoint, { operation, options = {} }) {
  const cfg = await getConfig();
  if (!cfg.token) throw new Error('Mosyle is not configured. Add MOSYLE_ACCESS_TOKEN in Settings → Integrations.');
  assertJwtShaped(cfg.token);

  const res = await axios.post(`${MOSYLE_API}/${endpoint}`, { operation, options }, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
    timeout: 15_000,
  });

  if (res.data?.status !== 'OK') {
    throw new Error(`Mosyle API error: ${res.data?.message || JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ---------------------------------------------------------------------------
// List all managed Apple devices
// ---------------------------------------------------------------------------
async function listDevices({ page = 0, type = 'ios' } = {}) {
  // type: ios | mac | tvos | appletv
  const data = await apiRequest('listdevices', {
    operation: 'list',
    options: { os: type, page },
  });
  return data.response?.[0]?.devices || data.response || [];
}

// Deliberately doesn't swallow per-type errors: an auth/server failure on
// one type used to be indistinguishable from "this school has 0 Macs", which
// made syncDevices() silently report success with 0 devices on a bad token.
async function listAllDevices() {
  const types   = ['ios', 'mac', 'tvos'];
  const results = await Promise.all(types.map(t => listDevices({ type: t })));
  return results.flat();
}

// ---------------------------------------------------------------------------
// Sync Mosyle devices into integration_devices table
// ---------------------------------------------------------------------------
async function syncDevices() {
  const devices = await listAllDevices();
  let count = 0;

  for (const d of devices) {
    const serial  = d.serial_number || d.SerialNumber || null;
    const model   = d.product_name  || d.model         || null;
    const name    = d.device_name   || d.DeviceName    || null;
    const os      = d.os_version    || d.OSVersion      || null;
    const user    = d.user_email    || null;
    const status  = d.device_status || d.status         || null;
    const macs    = [d.wifi_mac_address, d.bluetooth_mac].filter(Boolean);
    const ips     = [d.last_ip_address].filter(Boolean);
    const osType  = d.os_type || (name?.toLowerCase().includes('ipad') ? 'iPadOS' : 'iOS');

    await pool.query(
      `INSERT INTO integration_devices
         (source, external_id, serial_number, mac_addresses, device_name, device_model,
          os_type, os_version, assigned_email, ip_addresses, status, raw_data, synced_at)
       VALUES ('mosyle',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (source, external_id) DO UPDATE SET
         serial_number = EXCLUDED.serial_number, mac_addresses = EXCLUDED.mac_addresses,
         device_name = EXCLUDED.device_name, device_model = EXCLUDED.device_model,
         os_version = EXCLUDED.os_version, assigned_email = EXCLUDED.assigned_email,
         ip_addresses = EXCLUDED.ip_addresses, status = EXCLUDED.status,
         raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
      [serial || d.udid, serial, `{${macs.join(',')}}`, name, model,
       osType, os, user, `{${ips.join(',')}}`, status, JSON.stringify(d)]
    );
    count++;
  }

  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('last_mosyle_sync',$1,NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [new Date().toISOString()]
  );

  return count;
}

module.exports = { getConfig, listDevices, listAllDevices, syncDevices };
