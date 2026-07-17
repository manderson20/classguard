/**
 * UniFi Network Controller adapter.
 * Supports both legacy UniFi Controller (port 8443) and UniFi OS (port 443 / UDM).
 *
 * Auth: cookie-based login (username + password).
 * API:  /api/s/{site}/stat/sta   (legacy)  OR
 *       /proxy/network/api/s/{site}/stat/sta  (UniFi OS)
 */

const https = require('https');

async function request(baseUrl, path, method, body, cookies, agent, extraHeaders) {
  const axios = require('axios');
  const url   = `${baseUrl.replace(/\/$/, '')}${path}`;
  const res   = await axios({
    method,
    url,
    data:    body,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
      ...(extraHeaders || {}),
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
      // UniFi OS rejects mutating requests (POST/PUT/DELETE) without the CSRF
      // token it hands out at login; GETs work without it, which is why the
      // read-only sync never needed this.
      const csrf = res.headers['x-csrf-token'] || null;
      if (cookies) return { cookies, isOs: path.includes('auth'), csrf };
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
      // Same story for wired clients' switch: stat/sta carries sw_mac and
      // only rarely sw_name. Surface the MAC separately so the caller can
      // resolve the real switch name from fetchDevices(). Some sw_macs are
      // per-port interface MACs that appear nowhere on the device list (not
      // even in ethernet_table) — the controller resolves those itself in
      // last_uplink_name. Kept as a separate field (trusted only when
      // last_uplink_mac matches) so the caller can prefer the live
      // device-list name over this cached value.
      switch_mac:      c.sw_mac ? c.sw_mac.toLowerCase() : null,
      switch_name:     c['sw_name'] || null,
      uplink_name:     (c.sw_mac && c.last_uplink_name
        && (c.last_uplink_mac || '').toLowerCase() === c.sw_mac.toLowerCase())
        ? c.last_uplink_name : null,
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

// ---------------------------------------------------------------------------
// RADIUS setup — read/write the controller's RADIUS profiles and WLAN configs
// so ClassGuard can wire itself in as the site's RADIUS server from its own
// UI (create the "ClassGuard" profile, enable 802.1X / MAC auth per WLAN).
// UniFi's /rest/ endpoints accept partial PUT bodies — only send what changes.
// ---------------------------------------------------------------------------

async function restCall(config, method, restPath, body) {
  const { base_url, site_id = 'default' } = config;
  try {
    return await withSession(config, async ({ cookies, isOs, csrf }, agent) => {
      const apiBase = isOs ? '/proxy/network' : '';
      const headers = (method !== 'GET' && csrf) ? { 'X-Csrf-Token': csrf } : undefined;
      const res = await request(base_url, `${apiBase}/api/s/${site_id}${restPath}`, method, body, cookies, agent, headers);
      return res.data?.data ?? [];
    });
  } catch (err) {
    // Surface the controller's own error instead of axios's generic
    // "Request failed with status code 403" — the two 403s here mean very
    // different things (missing CSRF vs. an account without write rights).
    const msg = err.response?.data?.meta?.msg || err.response?.data?.error?.message;
    if (msg === 'api.err.NoPermission') {
      throw new Error(`account '${config.username}' can read but not modify the Network app (api.err.NoPermission) — in UniFi OS → Admins & Users, change its Network role from View Only to Full Management, then retry`, { cause: err });
    }
    if (msg) throw new Error(`${msg} (HTTP ${err.response.status})`, { cause: err });
    throw err;
  }
}

async function fetchRadiusProfiles(config) {
  return restCall(config, 'GET', '/rest/radiusprofile');
}

async function createRadiusProfile(config, profile) {
  const data = await restCall(config, 'POST', '/rest/radiusprofile', profile);
  return data[0] || null;
}

async function updateRadiusProfile(config, id, patch) {
  const data = await restCall(config, 'PUT', `/rest/radiusprofile/${id}`, patch);
  return data[0] || null;
}

async function fetchWlans(config) {
  return restCall(config, 'GET', '/rest/wlanconf');
}

async function updateWlan(config, id, patch) {
  const data = await restCall(config, 'PUT', `/rest/wlanconf/${id}`, patch);
  return data[0] || null;
}

/**
 * Fetch the site's configured networks (VLANs) — name, VLAN id, subnet,
 * DHCP settings. Informational: backs the VLAN-details popover in the UI.
 */
async function fetchNetworks(config) {
  const { base_url, site_id = 'default' } = config;

  return withSession(config, async ({ cookies, isOs }, agent) => {
    const apiBase = isOs ? '/proxy/network' : '';
    const res     = await request(
      base_url,
      `${apiBase}/api/s/${site_id}/rest/networkconf`,
      'GET',
      null,
      cookies,
      agent
    );

    const raw = res.data?.data || [];
    return raw
      .filter(n => (n.purpose || '') !== 'wan')
      .map(n => ({
        id:           n._id,
        name:         n.name || null,
        // The untagged default LAN carries no vlan field; vlan-only (L2)
        // networks carry vlan but often no subnet.
        vlan:         n.vlan != null ? Number(n.vlan) : null,
        purpose:      n.purpose || null,
        subnet:       n.ip_subnet || null,
        domain_name:  n.domain_name || null,
        dhcp_enabled: !!n.dhcpd_enabled,
        dhcp_start:   n.dhcpd_start || null,
        dhcp_stop:    n.dhcpd_stop || null,
        dhcp_dns:     [n.dhcpd_dns_1, n.dhcpd_dns_2, n.dhcpd_dns_3, n.dhcpd_dns_4].filter(Boolean),
        enabled:      n.enabled !== false,
      }));
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

module.exports = {
  fetchClients, fetchDevices, fetchNetworks, testConnection,
  fetchRadiusProfiles, createRadiusProfile, updateRadiusProfile,
  fetchWlans, updateWlan,
  vendor: 'unifi',
};
