const axios  = require('axios');
const { pool } = require('../db');

async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('snipeit_url','snipeit_token')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    url:   process.env.SNIPEIT_URL   || cfg.snipeit_url   || null,
    token: process.env.SNIPEIT_TOKEN || cfg.snipeit_token || null,
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

async function getClient() {
  const cfg = await getConfig();
  if (!cfg.url || !cfg.token) {
    throw new Error('Snipe-IT is not configured. Add SNIPEIT_URL and SNIPEIT_TOKEN in Settings → Integrations.');
  }
  // Snipe-IT Personal Access Tokens are long JWTs (Laravel Passport) —
  // typically 200+ characters with two dots. A short token is almost
  // certainly copied from the wrong place, so warn upfront rather than
  // let it fail with a bare "Unauthorized" from the server.
  if (cfg.token.length < 100 || cfg.token.split('.').length !== 3) {
    throw new Error(
      `Snipe-IT token looks too short/wrong-shaped to be a real Personal Access Token ` +
      `(those are long JWTs, 200+ characters). Generate one from your Snipe-IT account menu → ` +
      `"Manage API Keys" → "Create New Token", and copy the entire value.`
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

    await pool.query(
      `INSERT INTO integration_devices
         (source, external_id, serial_number, device_name, device_model,
          os_type, assigned_user, assigned_email, status, raw_data, synced_at)
       VALUES ('snipeit',$1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (source, external_id) DO UPDATE SET
         serial_number = EXCLUDED.serial_number, device_name = EXCLUDED.device_name,
         device_model = EXCLUDED.device_model, os_type = EXCLUDED.os_type,
         assigned_user = EXCLUDED.assigned_user, assigned_email = EXCLUDED.assigned_email,
         status = EXCLUDED.status, raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
      [String(a.id), serial, name, model, osType, user, user, status, JSON.stringify(a)]
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
