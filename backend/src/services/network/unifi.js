/**
 * UniFi Network Controller adapter.
 * Supports both legacy UniFi Controller (port 8443) and UniFi OS (port 443 / UDM).
 *
 * Auth: cookie-based login (username + password).
 * API:  /api/s/{site}/stat/sta   (legacy)  OR
 *       /proxy/network/api/s/{site}/stat/sta  (UniFi OS)
 */

const https = require('https');

// Ignore self-signed certs on local UniFi controllers
const agent = new https.Agent({ rejectUnauthorized: false });

async function request(baseUrl, path, method, body, cookies) {
  const axios = require('axios');
  const url   = `${baseUrl.replace(/\/$/, '')}${path}`;
  const res   = await axios({
    method,
    url,
    data:    body,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    httpsAgent: agent,
    timeout:    10_000,
  });
  return res;
}

async function login(baseUrl, username, password) {
  // Try UniFi OS endpoint first, fall back to legacy
  for (const path of ['/api/auth/login', '/api/login']) {
    try {
      const res = await request(baseUrl, path, 'POST', { username, password });
      const setCookie = res.headers['set-cookie'] || [];
      const cookies   = setCookie.map(c => c.split(';')[0]).join('; ');
      if (cookies) return { cookies, isOs: path.includes('auth') };
    } catch { /* try next */ }
  }
  throw new Error('UniFi login failed — check URL, username, and password');
}

async function logout(baseUrl, cookies, isOs) {
  const path = isOs ? '/api/auth/logout' : '/api/logout';
  await request(baseUrl, path, 'POST', {}, cookies).catch(() => {});
}

/**
 * Fetch all active + recently-seen clients from a UniFi site.
 * Returns array of normalised client objects.
 */
async function fetchClients(config) {
  const { base_url, username, password, site_id = 'default' } = config;
  if (!base_url || !username || !password) throw new Error('UniFi: base_url, username, password required');

  const { cookies, isOs } = await login(base_url, username, password);

  try {
    const apiBase = isOs ? '/proxy/network' : '';
    const res     = await request(
      base_url,
      `${apiBase}/api/s/${site_id}/stat/sta`,
      'GET',
      null,
      cookies
    );

    const raw = res.data?.data || [];
    return raw.map(c => ({
      mac:             (c.mac || '').toLowerCase(),
      ip_address:      c.ip || null,
      hostname:        c.hostname || c.name || null,
      ap_name:         c.ap_mac ? (c['ap_name'] || c.ap_mac) : null,
      ssid:            c.essid || null,
      rssi:            c.rssi   != null ? c.rssi   : null,
      channel:         c.channel != null ? c.channel : null,
      radio_type:      c.radio_proto || null,
      switch_name:     c.sw_mac ? (c['sw_name'] || c.sw_mac) : null,
      switch_port:     c.sw_port != null ? String(c.sw_port) : null,
      vlan:            c.vlan_id || c.vlan || null,
      connection_type: c.is_wired ? 'wired' : 'wireless',
      status:          'online',
      vendor_oui:      c.oui || null,
      first_seen:      c.first_seen ? new Date(c.first_seen * 1000) : null,
      last_seen:       c.last_seen  ? new Date(c.last_seen  * 1000) : null,
      raw_data:        c,
    }));
  } finally {
    await logout(base_url, cookies, isOs);
  }
}

/**
 * Test connectivity and auth — returns site list on success.
 */
async function testConnection(config) {
  const { base_url, username, password } = config;
  const { cookies, isOs } = await login(base_url, username, password);
  const apiBase = isOs ? '/proxy/network' : '';
  const res     = await request(base_url, `${apiBase}/api/self/sites`, 'GET', null, cookies);
  await logout(base_url, cookies, isOs);
  return { ok: true, sites: (res.data?.data || []).map(s => ({ id: s.name, desc: s.desc })) };
}

module.exports = { fetchClients, testConnection, vendor: 'unifi' };
