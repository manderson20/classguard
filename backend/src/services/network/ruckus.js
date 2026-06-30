/**
 * Ruckus SmartZone adapter.
 *
 * Auth: POST /wsg/api/public/v11_0/session (username/password → cookie)
 * Clients: POST /wsg/api/public/v11_0/query/client
 *
 * Also handles Ruckus Unleashed (home/SMB) which has a compatible REST API
 * but at a different base path. Set extra_config.flavor = 'unleashed' if needed.
 */

const axios = require('axios');
const https = require('https');

function apiBase(config) {
  const flavor = config.extra_config?.flavor || 'smartzone';
  if (flavor === 'unleashed') return `${config.base_url}/ajaxplorer/i/rks/api`;
  return `${config.base_url}/wsg/api/public/v11_0`;
}

// Cert validation controlled per-controller via extra_config.verify_ssl (default: off for LAN appliances)
function makeAgent(config) {
  return new https.Agent({ rejectUnauthorized: !!(config.extra_config?.verify_ssl) });
}

async function login(config, agent) {
  const { base_url, username, password } = config;
  if (!base_url || !username || !password) throw new Error('Ruckus: base_url, username, password required');

  const res = await axios.post(
    `${apiBase(config)}/session`,
    { username, password },
    { headers: { 'Content-Type': 'application/json' }, httpsAgent: agent, timeout: 10_000 }
  );
  const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  if (!cookies) throw new Error('Ruckus login failed — no session cookie returned');
  return cookies;
}

async function logout(config, cookies, agent) {
  await axios.delete(
    `${apiBase(config)}/session`,
    { headers: { Cookie: cookies }, httpsAgent: agent }
  ).catch(() => {});
}

async function fetchClients(config) {
  const agent   = makeAgent(config);
  const cookies = await login(config, agent);
  const results = [];
  let   index   = 0;
  const limit   = 100;

  try {
    while (true) {
      const res = await axios.post(
        `${apiBase(config)}/query/client`,
        {
          filters: [],
          fullTextSearch: { type: 'AND', value: '' },
          sortInfo: { dir: 'ASC', sortColumn: 'mac' },
          page: index,
          limit,
        },
        {
          headers: { 'Content-Type': 'application/json', Cookie: cookies },
          httpsAgent: agent,
          timeout: 15_000,
        }
      );

      const clients = res.data?.list || [];
      results.push(...clients);
      if (clients.length < limit) break;
      index += limit;
    }
  } finally {
    await logout(config, cookies, agent);
  }

  return results.map(c => ({
    mac:             (c.mac || '').toLowerCase(),
    ip_address:      c.ipAddress || null,
    hostname:        c.hostname  || null,
    ap_name:         c.apName    || null,
    ssid:            c.ssid      || null,
    rssi:            c.signal    != null ? c.signal : null,
    channel:         c.channel   != null ? c.channel : null,
    radio_type:      c.radioType || null,
    switch_name:     null,
    switch_port:     null,
    vlan:            c.vlan != null ? parseInt(c.vlan, 10) : null,
    connection_type: 'wireless',
    status:          c.status?.toLowerCase() === 'authorized' ? 'online' : 'offline',
    vendor_oui:      c.deviceType || null,
    os_type:         c.osType     || null,
    first_seen:      null,
    last_seen:       c.lastSeen ? new Date(c.lastSeen) : null,
    raw_data:        c,
  }));
}

async function testConnection(config) {
  const agent   = makeAgent(config);
  const cookies = await login(config, agent);
  await logout(config, cookies, agent);
  return { ok: true, message: 'Ruckus SmartZone login successful' };
}

module.exports = { fetchClients, testConnection, vendor: 'ruckus' };
