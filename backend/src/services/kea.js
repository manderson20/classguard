const axios  = require('axios');
const config = require('../config');

const KEA_URL = () => config.kea.controlAgentUrl;

// ---------------------------------------------------------------------------
// Core Kea Control Agent request
// ---------------------------------------------------------------------------
async function keaCommand(command, service, args = {}) {
  const body = { command, service: [service], arguments: args };

  let data;
  try {
    const res = await axios.post(KEA_URL(), body, {
      headers:  { 'Content-Type': 'application/json' },
      timeout:  10_000,
    });
    data = res.data;
  } catch (err) {
    throw new Error(`Kea request failed (${command}): ${err.message}`, { cause: err });
  }

  // Kea returns an array; the first element carries the result for our service
  const response = Array.isArray(data) ? data[0] : data;
  if (!response || response.result === undefined) {
    throw new Error(`Unexpected Kea response for ${command}`);
  }

  if (response.result !== 0 && response.result !== 3) {
    // result 3 = empty (not an error for get commands)
    throw new Error(`Kea ${command} failed: ${response.text || JSON.stringify(response)}`);
  }

  return response;
}

// ---------------------------------------------------------------------------
// Convert a dhcp_subnets DB row (+ its reservations) to a Kea subnet4 object.
// options: array of dhcp_options rows (global merged with per-subnet)
//
// Deliberately NOT using subnet4-add/-update/-del or reservation-add/-del —
// those require the subnet_cmds/host_cmds hook libraries, which are ISC
// commercial-only ("Kea Premium") and not available to us. Free Kea fully
// supports subnets and host reservations as plain config-file structures —
// just not as incremental runtime commands — so the whole subnet4 array
// (reservations embedded per-subnet) gets rebuilt and pushed via config-set
// instead, which is a core command available without any hooks.
// ---------------------------------------------------------------------------
function dbRowToKeaSubnet(row, options = [], reservations = []) {
  const subnet4 = {
    id:               row.kea_subnet_id,
    subnet:           row.subnet,
    'valid-lifetime': row.valid_lifetime_seconds || row.lease_time_seconds || 86400,
    pools: [{ pool: `${row.pool_start} - ${row.pool_end}` }],
    'option-data':    [],
  };

  // First-class fields (always included if set)
  if (row.gateway) {
    subnet4['option-data'].push({ name: 'routers', data: String(row.gateway) });
  }
  if (row.dns_servers && row.dns_servers.length) {
    subnet4['option-data'].push({
      name: 'domain-name-servers',
      data: row.dns_servers.join(', '),
    });
  }
  if (row.domain_name) {
    subnet4['option-data'].push({ name: 'domain-name', data: row.domain_name });
  }

  // Extra options from dhcp_options table (per-subnet overrides global for same name)
  const seen = new Set(subnet4['option-data'].map(o => o.name));
  for (const opt of options) {
    if (!opt.is_active) continue;
    if (seen.has(opt.option_name)) continue; // first-class fields take priority
    subnet4['option-data'].push({ name: opt.option_name, data: opt.option_data });
    seen.add(opt.option_name);
  }

  if (reservations.length) {
    subnet4.reservations = reservations.map(r => ({
      'hw-address': r.mac_address,
      'ip-address': r.ip_address,
      ...(r.hostname ? { hostname: r.hostname } : {}),
    }));
  }

  return subnet4;
}

// ---------------------------------------------------------------------------
// Fetch Kea's full current running config (so we only replace subnet4,
// not clobber hooks-libraries/lease-database/control-socket/etc).
// ---------------------------------------------------------------------------
async function getRunningConfig() {
  const res = await keaCommand('config-get', 'dhcp4', {});
  return res.arguments;
}

// ---------------------------------------------------------------------------
// Replace the entire subnet4 list (each entry carries its own reservations)
// in one shot via config-set, then config-write to persist to disk.
// config-write is best-effort — it only survives until the next container
// recreate anyway, which is why scheduler.js also re-runs this periodically.
// ---------------------------------------------------------------------------
async function applySubnets(subnet4) {
  const current = await getRunningConfig();
  await keaCommand('config-set', 'dhcp4', { Dhcp4: { ...current.Dhcp4, subnet4 } });
  try { await keaCommand('config-write', 'dhcp4', {}); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------
async function getLeases() {
  // lease4-get-all requires the 'subnets' key to be present to mean "all
  // subnets" — omitting it entirely (the previous behavior here) errors with
  // "'subnets' parameter not specified" instead of defaulting to all.
  const res = await keaCommand('lease4-get-all', 'dhcp4', { subnets: [] });
  return res.arguments?.leases ?? [];
}

async function getLease(ip) {
  const res = await keaCommand('lease4-get', 'dhcp4', {
    'op-type': 'by-address',
    ip,
  });
  return res.arguments?.lease ?? null;
}

async function deleteLease(ip) {
  await keaCommand('lease4-del', 'dhcp4', { ip });
}

// ---------------------------------------------------------------------------
// Pool utilization stats
// ---------------------------------------------------------------------------
async function getStats() {
  const res = await keaCommand('stat-lease4-get', 'dhcp4');
  return res.arguments?.result ?? [];
}

// ---------------------------------------------------------------------------
// HA heartbeat — checks all configured node URLs
// ---------------------------------------------------------------------------
async function getHAStatus() {
  const nodeUrls = config.kea.nodeUrls;

  if (!nodeUrls.length) {
    return { ha: false, message: 'No DHCP_NODE_URLS configured', nodes: [] };
  }

  const results = await Promise.allSettled(
    nodeUrls.map(async (url) => {
      const body = {
        command:   'ha-heartbeat',
        service:   ['dhcp4'],
        arguments: {},
      };
      const res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5_000,
      });
      const data = Array.isArray(res.data) ? res.data[0] : res.data;
      return { url, result: data.result, text: data.text, state: data.arguments?.state };
    })
  );

  const nodes = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { url: nodeUrls[i], result: -1, text: r.reason?.message ?? 'unreachable' }
  );

  return { ha: true, nodes };
}

module.exports = {
  keaCommand,
  dbRowToKeaSubnet,
  getRunningConfig,
  applySubnets,
  getLeases,
  getLease,
  deleteLease,
  getStats,
  getHAStatus,
};
