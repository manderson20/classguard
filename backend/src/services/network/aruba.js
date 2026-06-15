/**
 * Aruba adapter — supports both:
 *   1. Aruba Central (cloud) — OAuth2 client credentials
 *   2. Aruba Instant On / ArubaOS controller (on-prem) — username/password session
 *
 * Set extra_config.mode = 'central' | 'controller' (default: controller)
 */

const axios = require('axios');

// ---------------------------------------------------------------------------
// Aruba Central (cloud API)
// ---------------------------------------------------------------------------
async function getCentralToken(config) {
  const { api_key } = config;
  // Aruba Central supports API token directly — simplest path
  if (api_key) return api_key;
  throw new Error('Aruba Central: api_key (access token) required in controller config');
}

async function fetchCentralClients(config) {
  const token    = await getCentralToken(config);
  const baseUrl  = config.base_url || 'https://apigw-useast4.central.arubanetworks.com';
  const results  = [];
  let   offset   = 0;
  const limit    = 1000;

  while (true) {
    const res = await axios.get(`${baseUrl}/monitoring/v2/clients`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      params:  { limit, offset, client_type: 'WIRELESS' },
      timeout: 15_000,
    });
    const clients = res.data?.clients || [];
    results.push(...clients);
    if (clients.length < limit) break;
    offset += limit;
  }

  return results.map(c => ({
    mac:             (c.macaddr || '').toLowerCase(),
    ip_address:      c.ip_address || null,
    hostname:        c.name || null,
    ap_name:         c.associated_device || null,
    ssid:            c.network || null,
    rssi:            c.signal_db != null ? c.signal_db : null,
    channel:         c.channel  != null ? c.channel   : null,
    radio_type:      c.radio_type || null,
    switch_name:     null,
    switch_port:     null,
    vlan:            c.vlan != null ? c.vlan : null,
    connection_type: 'wireless',
    status:          c.client_type === 'ONLINE' ? 'online' : 'offline',
    vendor_oui:      c.manufacturer || null,
    os_type:         c.os_type || null,
    first_seen:      null,
    last_seen:       c.last_seen ? new Date(c.last_seen * 1000) : null,
    raw_data:        c,
  }));
}

// ---------------------------------------------------------------------------
// Aruba ArubaOS on-prem controller (cookie session)
// ---------------------------------------------------------------------------
async function fetchControllerClients(config) {
  const { base_url, username, password } = config;
  if (!base_url || !username || !password) {
    throw new Error('Aruba controller: base_url, username, password required');
  }

  const https  = require('https');
  const agent  = new https.Agent({ rejectUnauthorized: false });

  // Login
  const login = await axios.post(
    `${base_url}/api/login`,
    `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      httpsAgent: agent,
      timeout: 10_000,
    }
  );
  const uidAruba = login.data?.access_token || login.data?._global_result?.X_CSRF_Token || '';
  const cookies  = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  try {
    const res = await axios.get(`${base_url}/api/user-table`, {
      headers: { Cookie: cookies, ...(uidAruba ? { 'X-CSRF-Token': uidAruba } : {}) },
      httpsAgent: agent,
      timeout: 10_000,
    });

    const table = res.data?.Users?.User || [];
    return table.map(c => ({
      mac:             (c.macaddr || '').toLowerCase(),
      ip_address:      c.ipaddr || null,
      hostname:        c.name   || null,
      ap_name:         c.AP     || null,
      ssid:            c.ESSID  || null,
      rssi:            null,
      channel:         null,
      radio_type:      null,
      switch_name:     null,
      switch_port:     null,
      vlan:            c.vlan != null ? parseInt(c.vlan, 10) : null,
      connection_type: 'wireless',
      status:          'online',
      vendor_oui:      null,
      first_seen:      null,
      last_seen:       new Date(),
      raw_data:        c,
    }));
  } finally {
    await axios.post(`${base_url}/api/logout`, {}, { headers: { Cookie: cookies }, httpsAgent: agent }).catch(() => {});
  }
}

async function fetchClients(config) {
  const mode = config.extra_config?.mode || 'controller';
  if (mode === 'central') return fetchCentralClients(config);
  return fetchControllerClients(config);
}

async function testConnection(config) {
  const clients = await fetchClients(config);
  return { ok: true, client_count: clients.length };
}

module.exports = { fetchClients, testConnection, vendor: 'aruba' };
