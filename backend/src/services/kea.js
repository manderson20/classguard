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
    throw new Error(`Kea request failed (${command}): ${err.message}`);
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
// Convert a dhcp_subnets DB row to Kea subnet4 object
// options: array of dhcp_options rows (global merged with per-subnet)
// ---------------------------------------------------------------------------
function dbRowToKeaSubnet(row, options = []) {
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

  return subnet4;
}

// ---------------------------------------------------------------------------
// Sync a subnet to Kea (update → fallback to add)
// options: combined dhcp_options rows (global + per-subnet, caller resolves)
// ---------------------------------------------------------------------------
async function syncSubnet(row, options = []) {
  const subnet4 = dbRowToKeaSubnet(row, options);
  try {
    await keaCommand('subnet4-update', 'dhcp4', { subnet4: [subnet4] });
  } catch {
    await keaCommand('subnet4-add', 'dhcp4', { subnet4: [subnet4] });
  }
}

// ---------------------------------------------------------------------------
// Delete a subnet from Kea
// ---------------------------------------------------------------------------
async function deleteSubnet(keaSubnetId) {
  await keaCommand('subnet4-del', 'dhcp4', { id: keaSubnetId });
}

// ---------------------------------------------------------------------------
// Add a DHCP reservation to Kea
// ---------------------------------------------------------------------------
async function syncReservation(row) {
  await keaCommand('reservation-add', 'dhcp4', {
    reservation: {
      'subnet-id':  row.kea_subnet_id,
      'hw-address': row.mac_address,
      'ip-address': row.ip_address,
      ...(row.hostname ? { hostname: row.hostname } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Delete a DHCP reservation from Kea
// ---------------------------------------------------------------------------
async function deleteReservation(macAddress, keaSubnetId) {
  await keaCommand('reservation-del', 'dhcp4', {
    'subnet-id':  keaSubnetId,
    'identifier-type': 'hw-address',
    'identifier': macAddress,
  });
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------
async function getLeases() {
  const res = await keaCommand('lease4-get-all', 'dhcp4');
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
  syncSubnet,
  deleteSubnet,
  syncReservation,
  deleteReservation,
  getLeases,
  getLease,
  deleteLease,
  getStats,
  getHAStatus,
};
