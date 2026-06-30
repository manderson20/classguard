/**
 * UniFi Network Controller adapter.
 * Supports both legacy UniFi Controller (port 8443) and UniFi OS (port 443 / UDM).
 *
 * Auth: cookie-based login (username + password).
 * API:  /api/s/{site}/stat/sta   (legacy)  OR
 *       /proxy/network/api/s/{site}/stat/sta  (UniFi OS)
 */

const https = require('https');

async function request(baseUrl, path, method, body, cookies, agent) {
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

async function login(baseUrl, username, password, agent) {
  // Try UniFi OS endpoint first, fall back to legacy
  const failures = [];
  for (const path of ['/api/auth/login', '/api/login']) {
    try {
      const res = await request(baseUrl, path, 'POST', { username, password }, undefined, agent);
      const setCookie = res.headers['set-cookie'] || [];
      const cookies   = setCookie.map(c => c.split(';')[0]).join('; ');
      if (cookies) return { cookies, isOs: path.includes('auth') };
      failures.push(`${path}: no session cookie in response (HTTP ${res.status})`);
    } catch (err) {
      // Surface the real cause — a TLS/protocol mismatch (e.g. http:// against
      // a controller's HTTPS-only management port) looks nothing like a bad
      // password, and "check URL/username/password" alone hides that.
      const detail = err.response
        ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}`
        : err.code || err.message;
      failures.push(`${path}: ${detail}`);
    }
  }
  throw new Error(`UniFi login failed — ${failures.join('; ')}`);
}

// ---------------------------------------------------------------------------
// Session cache — UniFi (especially cloud-linked accounts) rate-limits login
// attempts aggressively. Logging in fresh on every sync/test call (every 15
// minutes via cron, plus manual Test/Sync clicks) risks tripping that limiter
// for no benefit, since UniFi OS sessions stay valid for a long idle window.
// Cache the cookie per controller and only re-login when it's missing, past
// our conservative expiry, or rejected with a 401 on actual use.
// ---------------------------------------------------------------------------
const sessionCache = new Map(); // key: `${base_url}|${username}` -> { cookies, isOs, expiresAt }
const SESSION_TTL_MS = 45 * 60 * 1000; // conservative — well under UniFi OS's idle timeout

function sessionKey(baseUrl, username) {
  return `${baseUrl}|${username}`;
}

async function getSession(baseUrl, username, password, agent, { forceFresh = false } = {}) {
  const key = sessionKey(baseUrl, username);
  const cached = sessionCache.get(key);
  if (!forceFresh && cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  const session = await login(baseUrl, username, password, agent);
  sessionCache.set(key, { ...session, expiresAt: Date.now() + SESSION_TTL_MS });
  return session;
}

function isAuthError(err) {
  return err.response && (err.response.status === 401 || err.response.status === 403);
}

/**
 * Run an authenticated request, transparently retrying once with a fresh
 * login if the cached session turns out to be stale (401/403).
 * Cert validation is controlled per-controller via extra_config.verify_ssl (default: off for LAN appliances).
 */
async function withSession(config, fn) {
  const { base_url, username, password } = config;
  if (!base_url || !username || !password) throw new Error('UniFi: base_url, username, password required');

  const agent = new https.Agent({ rejectUnauthorized: !!(config.extra_config?.verify_ssl) });
  let session = await getSession(base_url, username, password, agent);
  try {
    return await fn(session, agent);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    sessionCache.delete(sessionKey(base_url, username));
    session = await getSession(base_url, username, password, agent, { forceFresh: true });
    return await fn(session, agent);
  }
}

/**
 * Fetch all active + recently-seen clients from a UniFi site.
 * Returns array of normalised client objects.
 */
async function fetchClients(config) {
  const { base_url, site_id = 'default' } = config;

  return withSession(config, async ({ cookies, isOs }, agent) => {
    const apiBase = isOs ? '/proxy/network' : '';
    const res     = await request(
      base_url,
      `${apiBase}/api/s/${site_id}/stat/sta`,
      'GET',
      null,
      cookies,
      agent
    );

    const raw = res.data?.data || [];
    return raw.map(c => ({
      mac:             (c.mac || '').toLowerCase(),
      ip_address:      c.ip || null,
      hostname:        c.hostname || c.name || null,
      // UniFi's client/station API never actually includes a resolved AP
      // name (only ap_mac) - the real name only exists on the device list
      // (fetchDevices). Surface the raw MAC here; the caller cross-references
      // it against fetchDevices() to resolve the real name, falling back to
      // this MAC only if that lookup comes up empty.
      ap_mac:          c.ap_mac ? c.ap_mac.toLowerCase() : null,
      ap_name:         c['ap_name'] || null,
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
  });
}

/**
 * Fetch infrastructure devices (APs, switches, gateways) for a site —
 * distinct from fetchClients(), which returns end-user stations.
 */
async function fetchDevices(config) {
  const { base_url, site_id = 'default' } = config;

  return withSession(config, async ({ cookies, isOs }, agent) => {
    const apiBase = isOs ? '/proxy/network' : '';
    const res     = await request(
      base_url,
      `${apiBase}/api/s/${site_id}/stat/device`,
      'GET',
      null,
      cookies,
      agent
    );

    const raw = res.data?.data || [];
    return raw.map(d => ({
      mac:       (d.mac || '').toLowerCase(),
      ip:        d.ip || null,
      name:      d.name || d.mac,
      model:     d.model || null,
      type:      d.type || 'other', // uap, usw, uxg/ugw
      isOnline:  d.state === 1,
    })).filter(d => d.ip);
  });
}

/**
 * Test connectivity and auth — returns site list on success.
 */
async function testConnection(config) {
  const { base_url } = config;
  const sites = await withSession(config, async ({ cookies, isOs }, agent) => {
    const apiBase = isOs ? '/proxy/network' : '';
    const res     = await request(base_url, `${apiBase}/api/self/sites`, 'GET', null, cookies, agent);
    return (res.data?.data || []).map(s => ({ id: s.name, desc: s.desc }));
  });
  return { ok: true, sites };
}

module.exports = { fetchClients, fetchDevices, testConnection, vendor: 'unifi' };
