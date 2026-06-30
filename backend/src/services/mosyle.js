const axios  = require('axios');
const { pool } = require('../db');

// Verified live against a real Mosyle Manager account (the "My School" /
// education product — NOT Mosyle Business, a different product+API+base
// URL that everything here was originally, wrongly, built against).
const MOSYLE_API = 'https://managerapi.mosyle.com/v2';

async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('mosyle_access_token','mosyle_email','mosyle_password')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    token:    process.env.MOSYLE_ACCESS_TOKEN || cfg.mosyle_access_token || null,
    email:    cfg.mosyle_email    || null,
    password: cfg.mosyle_password || null,
  };
}

// Mosyle Manager's token-only ("Basic Auth") mode is deprecated — confirmed
// live, it 401s with "API Token or Bearer Token are incorrect" even with a
// valid access token. The only working auth now is: POST the access token +
// an admin email/password to /login, which returns a Bearer JWT in the
// response's Authorization HEADER (not body), valid 24h. That Bearer token
// (plus the access token, still in the body) is then required on every
// other call. Cached in-process — a restart just re-logs-in on next use.
let cachedBearer = null; // { token, expiresAt }

async function getBearerToken(cfg) {
  if (cachedBearer && cachedBearer.expiresAt > Date.now()) return cachedBearer.token;

  if (!cfg.email || !cfg.password) {
    throw new Error(
      'Mosyle email/password not configured. Mosyle now requires a JWT login (their token-only ' +
      '"Basic Auth" mode is deprecated) — add an admin email/password in Integrations → Mosyle.'
    );
  }

  let res;
  try {
    res = await axios.post(`${MOSYLE_API}/login`, {
      accessToken: cfg.token, email: cfg.email, password: cfg.password,
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 });
  } catch (err) {
    const detail = err.response?.data?.['error-description'] || err.response?.data?.error;
    throw new Error(detail ? `Mosyle login failed: ${detail}` : `Mosyle login failed: ${err.message}`, { cause: err });
  }

  const bearer = res.headers['authorization'];
  if (!bearer) throw new Error('Mosyle /login succeeded but returned no Authorization header');

  // Refresh a bit before the real 24h expiry so a request never lands right at the edge.
  cachedBearer = { token: bearer, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
  return bearer;
}

async function apiRequest(endpoint, { options = {} } = {}) {
  const cfg = await getConfig();
  if (!cfg.token) throw new Error('Mosyle is not configured. Add the access token in Integrations → Mosyle.');

  const bearer = await getBearerToken(cfg);

  let res;
  try {
    res = await axios.post(`${MOSYLE_API}/${endpoint}`, { accessToken: cfg.token, options }, {
      headers: { 'Content-Type': 'application/json', Authorization: bearer },
      timeout: 15_000,
    });
  } catch (err) {
    // A 401 here likely means the cached bearer expired early or was
    // revoked — drop it so the *next* call re-logs-in instead of retrying
    // the same dead token forever.
    if (err.response?.status === 401) cachedBearer = null;
    const detail = err.response?.data?.error || err.response?.data?.message || err.response?.data?.['error-description'];
    throw new Error(detail ? `Mosyle API error: ${detail}` : err.message, { cause: err });
  }

  // Only Mosyle's outer envelope is checked here — res.data.response may
  // carry its own nested "status" (e.g. DATA_WRONGFORMAT) for a specific
  // operation, which callers should check themselves.
  if (res.data?.status && res.data.status !== 'OK') {
    throw new Error(`Mosyle API error: ${res.data?.message || JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ---------------------------------------------------------------------------
// List all managed Apple devices
// ---------------------------------------------------------------------------
async function listDevices({ type = 'ios' } = {}) {
  // type: ios | mac | tvos | appletv
  // response shape: { status: 'OK', response: { devices: [...], rows, page_size, page } }
  const devices = [];
  let page = 1;
  for (;;) {
    const data  = await apiRequest('listdevices', { options: { os: type, page } });
    const batch = data.response?.devices || [];
    devices.push(...batch);
    const pageSize = data.response?.page_size || batch.length;
    if (batch.length < pageSize || !batch.length) break;
    page++;
  }
  return devices;
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

  // Fetch cert replacement date once for the whole sync batch.
  const { rows: certRows } = await pool.query(
    `SELECT value FROM settings WHERE key = 'apns_cert_replaced_on'`
  );
  const certDate = certRows[0]?.value ? new Date(certRows[0].value) : null;

  let count = 0;

  for (const d of devices) {
    const serial  = d.serial_number || d.SerialNumber || null;
    const model   = d.product_name  || d.model         || null;
    const name    = d.device_name   || d.DeviceName    || null;
    const os      = d.os_version    || d.OSVersion      || null;
    const user    = d.user_email    || null;
    const status  = d.device_status || d.status         || null;
    const macs    = [d.wifi_mac_address, d.ethernet_mac_address, d.bluetooth_mac_address].filter(Boolean);
    const ips     = [d.last_ip_address].filter(Boolean);

    // Mosyle returns os='mac' for Macs, os='ios' for both iPhones and iPads (differentiated by name)
    const rawOs  = (d.os_type || d.os || '').toLowerCase();
    const osType = rawOs === 'mac'    ? 'macOS'
      : rawOs === 'tvos'              ? 'tvOS'
      : rawOs === 'ipados'            ? 'iPadOS'
      : name?.toLowerCase().includes('ipad') ? 'iPadOS'
      : 'iOS';

    // date_enroll is a Unix timestamp in seconds
    const enrolledAt = d.date_enroll && parseInt(d.date_enroll, 10) > 0
      ? new Date(parseInt(d.date_enroll, 10) * 1000)
      : null;

    // Determine APNS cert status: true = enrolled after cert replacement (new cert),
    // false = enrolled before (needs re-enrollment), null = no cert date configured yet.
    const apnsCertOk = certDate && enrolledAt ? enrolledAt >= certDate : null;

    await pool.query(
      `INSERT INTO integration_devices
         (source, external_id, serial_number, mac_addresses, device_name, device_model,
          os_type, os_version, assigned_email, ip_addresses, status, raw_data,
          enrolled_at, apns_cert_ok, synced_at)
       VALUES ('mosyle',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (source, external_id) DO UPDATE SET
         serial_number = EXCLUDED.serial_number, mac_addresses = EXCLUDED.mac_addresses,
         device_name = EXCLUDED.device_name, device_model = EXCLUDED.device_model,
         os_type = EXCLUDED.os_type, os_version = EXCLUDED.os_version,
         assigned_email = EXCLUDED.assigned_email,
         ip_addresses = EXCLUDED.ip_addresses, status = EXCLUDED.status,
         enrolled_at = EXCLUDED.enrolled_at,
         apns_cert_ok = EXCLUDED.apns_cert_ok,
         raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
      [serial || d.deviceudid || d.udid, serial, `{${macs.join(',')}}`, name, model,
       osType, os, user, `{${ips.join(',')}}`, status, JSON.stringify(d), enrolledAt, apnsCertOk]
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

// ---------------------------------------------------------------------------
// Push asset tags from Snipe-IT back to Mosyle device records.
// Mosyle API requires one request per OS family (ios covers both iOS + iPadOS).
// Only updates the local integration_devices row on success so the cross-sync
// can retry on next run if a device is temporarily unreachable.
//
// Verified endpoint: POST /v2/devices with { accessToken, os, elements: [{serialnumber, asset_tag}] }
// (NOT /editdevice — that endpoint does not exist in Mosyle Manager v2).
// Success: device serial appears in data.devices[]; per-device errors in data.elements[].
// ---------------------------------------------------------------------------
function toMosyleOs(osType) {
  if (osType === 'macOS') return 'mac';
  if (osType === 'tvOS')  return 'tvos';
  return 'ios'; // iOS and iPadOS both use 'ios' in Mosyle API
}

async function pushAssetTags(updates) {
  // updates: [{ serialNumber, osType, assetTag }]
  // Returns: [{ serialNumber, ok: bool, error: string|null }]
  const cfg    = await getConfig();
  if (!cfg.token) throw new Error('Mosyle is not configured. Add the access token in Integrations → Mosyle.');
  const bearer = await getBearerToken(cfg);

  const byOs = new Map();
  for (const u of updates) {
    const os = toMosyleOs(u.osType || 'iOS');
    if (!byOs.has(os)) byOs.set(os, []);
    // Mosyle /devices uses 'serialnumber' (no underscore), not 'serial_number'
    byOs.get(os).push({ serialnumber: u.serialNumber, asset_tag: u.assetTag });
  }

  const out = [];
  for (const [os, elements] of byOs) {
    for (let i = 0; i < elements.length; i += 100) {
      const batch = elements.slice(i, i + 100);
      try {
        let res;
        try {
          res = await axios.post(`${MOSYLE_API}/devices`, {
            accessToken: cfg.token, os, elements: batch,
          }, {
            headers: { 'Content-Type': 'application/json', Authorization: bearer },
            timeout: 30_000,
          });
        } catch (err) {
          if (err.response?.status === 401) cachedBearer = null;
          const detail = err.response?.data?.error || err.response?.data?.message;
          throw new Error(detail ? `Mosyle API error: ${detail}` : err.message, { cause: err });
        }

        const data = res.data;
        if (data?.status && data.status !== 'OK') {
          throw new Error(`Mosyle API error: ${data?.message || JSON.stringify(data)}`);
        }

        // Successful devices are listed in data.devices[]; per-device errors in data.elements[]
        const successSet = new Set(data.devices || []);
        for (const el of batch) {
          const ok = successSet.has(el.serialnumber);
          if (ok) {
            out.push({ serialNumber: el.serialnumber, ok: true, error: null });
          } else {
            const elErr = Array.isArray(data.elements)
              ? data.elements.find(e => e.serial === el.serialnumber || e.serialnumber === el.serialnumber)
              : null;
            out.push({ serialNumber: el.serialnumber, ok: false, error: elErr?.info || elErr?.status || 'not in Mosyle response devices list' });
          }
        }
      } catch (err) {
        for (const el of batch) out.push({ serialNumber: el.serialnumber, ok: false, error: err.message });
      }
    }
  }
  return out;
}

module.exports = { getConfig, listDevices, listAllDevices, syncDevices, pushAssetTags };
