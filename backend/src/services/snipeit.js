const axios  = require('axios');
const { pool } = require('../db');

async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN
       ('snipeit_url','snipeit_token','snipeit_client_id','snipeit_client_secret')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    url:          process.env.SNIPEIT_URL           || cfg.snipeit_url           || null,
    token:        process.env.SNIPEIT_TOKEN         || cfg.snipeit_token         || null,
    clientId:     process.env.SNIPEIT_CLIENT_ID      || cfg.snipeit_client_id     || null,
    clientSecret: process.env.SNIPEIT_CLIENT_SECRET  || cfg.snipeit_client_secret || null,
  };
}

function buildClient(url, token) {
  return axios.create({
    baseURL: url.replace(/\/$/, '') + '/api/v1',
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// OAuth2 client_credentials token exchange — for Snipe-IT instances where
// the admin can only create an OAuth Client (client_id/secret) rather than
// generate a Personal Access Token from the account menu. Laravel Passport
// (what Snipe-IT's API runs on) supports this grant at the protocol level;
// the resulting access_token is cached in-process and refreshed shortly
// before it expires. Not persisted anywhere — a backend restart just means
// the next request re-fetches one, which is cheap and avoids storing a
// short-lived secret outside the settings table.
// ---------------------------------------------------------------------------
let cachedOAuthToken = null; // { accessToken, expiresAt }

async function fetchOAuthToken(url, clientId, clientSecret) {
  const res = await axios.post(`${url.replace(/\/$/, '')}/oauth/token`, {
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  }, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 15_000,
  });
  const { access_token, expires_in } = res.data || {};
  if (!access_token) throw new Error('Snipe-IT OAuth token response had no access_token');
  return { accessToken: access_token, expiresAt: Date.now() + (expires_in ? expires_in * 1000 : 3600_000) };
}

async function getOAuthAccessToken(url, clientId, clientSecret) {
  // Refresh 60s before expiry rather than reacting to a 401, so a sync that
  // makes many requests doesn't get cut off mid-run by token expiry.
  if (cachedOAuthToken && cachedOAuthToken.expiresAt > Date.now() + 60_000) {
    return cachedOAuthToken.accessToken;
  }
  try {
    cachedOAuthToken = await fetchOAuthToken(url, clientId, clientSecret);
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
    throw new Error(`Snipe-IT OAuth token exchange failed: ${detail}`);
  }
  return cachedOAuthToken.accessToken;
}

async function getClient() {
  const cfg = await getConfig();
  if (!cfg.url) {
    throw new Error('Snipe-IT is not configured. Add SNIPEIT_URL in Settings → Integrations.');
  }

  if (cfg.clientId && cfg.clientSecret) {
    const accessToken = await getOAuthAccessToken(cfg.url, cfg.clientId, cfg.clientSecret);
    return buildClient(cfg.url, accessToken);
  }

  if (!cfg.token) {
    throw new Error(
      'Snipe-IT is not configured. Add either a Personal Access Token, or an OAuth Client ID + Secret, in Settings → Integrations.'
    );
  }
  // Snipe-IT Personal Access Tokens are long JWTs (Laravel Passport) —
  // typically 200+ characters with two dots. A short token is almost
  // certainly copied from the wrong place, so warn upfront rather than
  // let it fail with a bare "Unauthorized" from the server.
  if (cfg.token.length < 100 || cfg.token.split('.').length !== 3) {
    throw new Error(
      `Snipe-IT token looks too short/wrong-shaped to be a real Personal Access Token ` +
      `(those are long JWTs, 200+ characters). Generate one from your Snipe-IT account menu → ` +
      `"Manage API Keys" → "Create New Token", and copy the entire value — or use the OAuth ` +
      `Client ID + Secret fields instead if that's what your instance lets you create.`
    );
  }
  return buildClient(cfg.url, cfg.token);
}

// ---------------------------------------------------------------------------
// Paginate through all hardware assets
// ---------------------------------------------------------------------------
async function listAssets({ search } = {}) {
  const http   = await getClient();
  const assets = [];
  let offset   = 0;
  const limit  = 500;

  while (true) {
    const params = { limit, offset, sort: 'id', order: 'asc' };
    if (search) params.search = search;
    const res = await http.get('/hardware', { params });
    const rows = res.data?.rows || [];
    assets.push(...rows);
    if (assets.length >= (res.data?.total || 0) || !rows.length) break;
    offset += limit;
  }

  return assets;
}

async function getAsset(id) {
  const http = await getClient();
  const res  = await http.get(`/hardware/${id}`);
  return res.data;
}

// ---------------------------------------------------------------------------
// Sync Snipe-IT assets into integration_devices
// ---------------------------------------------------------------------------
async function syncAssets() {
  const assets = await listAssets();
  let count = 0;

  for (const a of assets) {
    const serial  = a.serial || null;
    const model   = a.model?.name || null;
    const name    = a.name || null;
    const user    = a.assigned_to?.email || a.assigned_to?.name || null;
    const status  = a.status_label?.name || null;
    const osType  = a.category?.name || null;

    // Snipe-IT has no first-class MAC field — most districts track it in a
    // custom field instead (naming varies, hence the fuzzy match on the
    // field label rather than a fixed key).
    const customMac = Object.values(a.custom_fields || {})
      .find(f => /mac/i.test(f.field || '') && f.value)?.value;
    const macs = [a.mac_address, customMac].filter(Boolean);

    await pool.query(
      `INSERT INTO integration_devices
         (source, external_id, serial_number, mac_addresses, device_name, device_model,
          os_type, assigned_user, assigned_email, status, raw_data, synced_at)
       VALUES ('snipeit',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (source, external_id) DO UPDATE SET
         serial_number = EXCLUDED.serial_number, mac_addresses = EXCLUDED.mac_addresses,
         device_name = EXCLUDED.device_name,
         device_model = EXCLUDED.device_model, os_type = EXCLUDED.os_type,
         assigned_user = EXCLUDED.assigned_user, assigned_email = EXCLUDED.assigned_email,
         status = EXCLUDED.status, raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
      [String(a.id), serial, `{${macs.join(',')}}`, name, model, osType, user, user, status, JSON.stringify(a)]
    );
    count++;
  }

  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('last_snipeit_sync',$1,NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [new Date().toISOString()]
  );

  return count;
}

module.exports = { getConfig, listAssets, getAsset, syncAssets };
