/**
 * Cisco Meraki cloud adapter.
 *
 * Auth: X-Cisco-Meraki-API-Key header (Dashboard API key).
 * site_id maps to Meraki Network ID (e.g. L_12345678).
 *
 * Note: Meraki has a 5-calls/sec rate limit per API key.
 * We paginate with perPage=1000 and use the Link header for continuation.
 */

const axios = require('axios');

const BASE = 'https://api.meraki.com/api/v1';

function headers(apiKey) {
  return {
    'X-Cisco-Meraki-API-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

async function paginate(url, apiKey) {
  const results = [];
  let   nextUrl = url;

  while (nextUrl) {
    const res = await axios.get(nextUrl, { headers: headers(apiKey), timeout: 15_000 });
    const data = Array.isArray(res.data) ? res.data : [];
    results.push(...data);

    // Meraki uses Link header for pagination
    const link = res.headers['link'] || '';
    const next  = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
    nextUrl = next;
  }
  return results;
}

async function fetchClients(config) {
  const { api_key, site_id } = config;
  if (!api_key) throw new Error('Meraki: api_key required');
  if (!site_id) throw new Error('Meraki: site_id (network ID) required');

  // Fetch clients active in last 86400 seconds (24h)
  const url  = `${BASE}/networks/${site_id}/clients?perPage=1000&timespan=86400`;
  const raw  = await paginate(url, api_key);

  // Enrich: try to get AP associations from wireless client details
  return raw.map(c => ({
    mac:             (c.mac || '').toLowerCase(),
    ip_address:      c.ip  || c.ip6 || null,
    hostname:        c.description || c.dhcpHostname || null,
    ap_name:         c.recentDeviceName || null,
    ssid:            c.ssid || null,
    rssi:            c.rssi != null ? c.rssi : null,
    channel:         null,
    radio_type:      null,
    switch_name:     c.switchportId ? c.recentDeviceName : null,
    switch_port:     c.switchportId || null,
    vlan:            c.vlan != null ? c.vlan : null,
    connection_type: c.switchportId ? 'wired' : (c.ssid ? 'wireless' : null),
    status:          c.status === 'Online' ? 'online' : 'offline',
    vendor_oui:      c.manufacturer || null,
    os_type:         c.os || null,
    first_seen:      c.firstSeen ? new Date(c.firstSeen) : null,
    last_seen:       c.lastSeen  ? new Date(c.lastSeen)  : null,
    raw_data:        c,
  }));
}

async function testConnection(config) {
  const { api_key } = config;
  if (!api_key) throw new Error('Meraki: api_key required');
  const res = await axios.get(`${BASE}/organizations`, { headers: headers(api_key), timeout: 10_000 });
  const orgs = res.data || [];
  return { ok: true, organizations: orgs.map(o => ({ id: o.id, name: o.name })) };
}

module.exports = { fetchClients, testConnection, vendor: 'meraki' };
