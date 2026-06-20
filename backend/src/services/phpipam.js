/**
 * PHPiPAM Import Service
 *
 * Uses the PHPiPAM REST API to export subnets, IP addresses, VLANs, VRFs,
 * and sections, then imports them into ClassGuard's IPAM tables.
 *
 * PHPiPAM apps (Administration → API) use one of two unrelated auth modes,
 * selected per-app in PHPiPAM itself — we have to match whichever the admin
 * picked there:
 *   - "SSL with User token": POST /api/{app_id}/user/ with username+password
 *     (HTTP Basic) → returns a session token, used as Authorization: Token
 *     <token> on subsequent requests, and revoked with DELETE /user/ when done.
 *   - "SSL with App code": no login step — the App Code configured in PHPiPAM
 *     *is* the token. Used directly as Authorization: Token <app_code>.
 */

const axios  = require('axios');
const https  = require('https');
const { pool } = require('../db');

async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('phpipam_url','phpipam_app_id','phpipam_username','phpipam_password',
                    'phpipam_verify_ssl','phpipam_auth_mode','phpipam_app_code')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    url:       process.env.PHPIPAM_URL      || cfg.phpipam_url      || null,
    appId:     process.env.PHPIPAM_APP_ID   || cfg.phpipam_app_id   || null,
    username:  process.env.PHPIPAM_USERNAME || cfg.phpipam_username || null,
    password:  process.env.PHPIPAM_PASSWORD || cfg.phpipam_password || null,
    // 'user_token' (default) or 'app_code' — must match the App security
    // setting configured for this app inside PHPiPAM itself.
    authMode:  cfg.phpipam_auth_mode || 'user_token',
    appCode:   cfg.phpipam_app_code  || null,
    // Many self-hosted PHPiPAM instances run with a self-signed cert on the
    // LAN; default to verifying but let the admin opt out per-instance.
    verifySsl: cfg.phpipam_verify_ssl !== 'false',
  };
}

// Surfaces PHPiPAM's actual JSON error body (e.g. "Invalid username or
// password", "Application doesn't allow access from this IP") instead of
// axios's generic "Request failed with status code 401".
function describeError(err) {
  const body   = err.response?.data;
  const detail = body?.message || body?.error || err.message;
  const url    = err.config ? `${err.config.baseURL || ''}${err.config.url || ''}` : null;
  if (err.response && url) return `${detail} (HTTP ${err.response.status} from ${url})`;
  return detail;
}

function httpsAgent(cfg) {
  return cfg.url.startsWith('https') ? new https.Agent({ rejectUnauthorized: cfg.verifySsl }) : undefined;
}

async function authenticate(cfg) {
  let res;
  try {
    res = await axios.post(
      `${cfg.url.replace(/\/$/, '')}/api/${cfg.appId}/user/`,
      {},
      {
        auth:       { username: cfg.username, password: cfg.password },
        timeout:    10_000,
        httpsAgent: httpsAgent(cfg),
      }
    );
  } catch (err) {
    throw new Error(describeError(err));
  }
  if (!res.data?.data?.token) throw new Error('PHPiPAM authentication failed — check App ID, username, and password');
  return res.data.data.token;
}

// Returns a usable token for either auth mode, without assuming which one is configured.
async function getToken(cfg) {
  if (cfg.authMode === 'app_code') {
    if (!cfg.appCode) throw new Error('App Code is required when using "App code" auth mode');
    return cfg.appCode;
  }
  if (!cfg.username || !cfg.password) throw new Error('Username and password are required when using "User token" auth mode');
  return authenticate(cfg);
}

// App-code tokens are static (configured in PHPiPAM, not a session) — only
// user-token sessions need to be explicitly revoked when we're done with them.
async function revokeToken(cfg, http) {
  if (cfg.authMode !== 'app_code') await http.delete('/user/').catch(() => {});
}

function buildClient(cfg, token) {
  return axios.create({
    baseURL:    `${cfg.url.replace(/\/$/, '')}/api/${cfg.appId}`,
    headers:    { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    timeout:    15_000,
    httpsAgent: httpsAgent(cfg),
  });
}

// ---------------------------------------------------------------------------
// Connection test — authenticate, then immediately revoke the token.
// ---------------------------------------------------------------------------
async function testConnection() {
  const cfg = await getConfig();
  if (!cfg.url || !cfg.appId) {
    throw new Error('PHPiPAM connection not configured. Set URL and App ID first.');
  }
  const token = await getToken(cfg);
  const http  = buildClient(cfg, token);
  // Confirm the token actually works, not just that we obtained one —
  // app-code tokens in particular aren't validated until first real request.
  try {
    await http.get('/sections/');
  } catch (err) {
    throw new Error(describeError(err));
  }
  await revokeToken(cfg, http);
  return true;
}

// ---------------------------------------------------------------------------
// Full import — run in background, stream progress via events
// ---------------------------------------------------------------------------
async function runImport(onProgress = () => {}) {
  const cfg = await getConfig();
  if (!cfg.url || !cfg.appId) {
    throw new Error('PHPiPAM connection not configured. Set credentials in Settings → Integrations.');
  }

  const token  = await getToken(cfg);
  const http   = buildClient(cfg, token);
  const report = { sections: 0, vrfs: 0, vlans: 0, subnets: 0, addresses: 0, errors: [] };

  // -- Sections --
  onProgress('Importing sections…');
  try {
    const { data } = await http.get('/sections/');
    for (const s of (data.data || [])) {
      await pool.query(
        `INSERT INTO ipam_sections (name, description)
         VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [s.name, s.description || null]
      ).catch(() => {});
      report.sections++;
    }
  } catch (e) { report.errors.push(`sections: ${e.message}`); }

  // -- VRFs --
  onProgress('Importing VRFs…');
  try {
    const { data } = await http.get('/vrf/');
    for (const v of (data.data || [])) {
      await pool.query(
        `INSERT INTO vrfs (name, rd, description)
         VALUES ($1,$2,$3)
         ON CONFLICT (name) DO UPDATE SET rd = EXCLUDED.rd, description = EXCLUDED.description`,
        [v.name, v.rd || null, v.description || null]
      ).catch(() => {});
      report.vrfs++;
    }
  } catch (e) { report.errors.push(`vrfs: ${e.message}`); }

  // -- VLANs --
  onProgress('Importing VLANs…');
  try {
    const { data } = await http.get('/vlan/');
    for (const v of (data.data || [])) {
      await pool.query(
        `INSERT INTO vlans (vlan_id, name, description)
         VALUES ($1,$2,$3)
         ON CONFLICT (vlan_id) DO UPDATE SET name = EXCLUDED.name`,
        [parseInt(v.vlanId || v.number, 10), v.name, v.description || null]
      ).catch(() => {});
      report.vlans++;
    }
  } catch (e) { report.errors.push(`vlans: ${e.message}`); }

  // -- Subnets --
  onProgress('Importing subnets…');
  try {
    const { data } = await http.get('/subnets/cidr/');
    const subnets  = data.data || [];

    // Also try the full list endpoint
    const { data: allData } = await http.get('/subnets/').catch(() => ({ data: { data: [] } }));
    const allSubnets = allData.data || [];
    const combined  = [...new Map([...subnets, ...allSubnets].map(s => [s.id, s])).values()];

    for (const s of combined) {
      if (!s.subnet || !s.mask) continue;
      const cidr = `${s.subnet}/${s.mask}`;
      try {
        const ipVersion = cidr.includes(':') ? 6 : 4;
        await pool.query(
          `INSERT INTO ipam_subnets (subnet, ip_version, name, description, gateway, notes)
           VALUES ($1::cidr,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [cidr, ipVersion, s.sectionId ? `[${s.sectionId}] ${s.description}` : s.description,
           s.description, s.gateway || null, s.deviceId || null]
        );
        report.subnets++;
      } catch (e) { report.errors.push(`subnet ${cidr}: ${e.message}`); }
    }
  } catch (e) { report.errors.push(`subnets: ${e.message}`); }

  // -- IP Addresses --
  onProgress('Importing IP addresses (this may take a while)…');
  try {
    const { data } = await http.get('/addresses/').catch(() => ({ data: { data: [] } }));
    for (const a of (data.data || [])) {
      if (!a.ip) continue;
      const status = a.state === '0' ? 'free' :
                     a.state === '2' ? 'reserved' :
                     a.state === '3' ? 'offline' : 'used';
      try {
        await pool.query(
          `INSERT INTO ip_addresses (ip, hostname, description, mac_address, owner, status, notes)
           VALUES ($1,$2,$3,$4::macaddr,$5,$6,$7)
           ON CONFLICT (ip) DO NOTHING`,
          [a.ip, a.hostname || null, a.description || null,
           a.mac ? a.mac.replace(/-/g, ':') : null,
           a.owner || null, status, a.note || null]
        );
        report.addresses++;
      } catch (e) { report.errors.push(`address ${a.ip}: ${e.message}`); }
    }
  } catch (e) { report.errors.push(`addresses: ${e.message}`); }

  await revokeToken(cfg, http);

  onProgress(`Import complete: ${report.subnets} subnets, ${report.addresses} addresses.`);
  return report;
}

module.exports = { getConfig, runImport, testConnection };
