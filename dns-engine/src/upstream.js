const DNS         = require('dns2');
const policyCache = require('./policyCache');

// Map dns2 numeric TYPE values to strings the client understands
const TYPE_NAMES = {
  1:   'A',
  2:   'NS',
  5:   'CNAME',
  6:   'SOA',
  12:  'PTR',
  15:  'MX',
  16:  'TXT',
  28:  'AAAA',
  33:  'SRV',
  255: 'ANY',
};

// Clients are rebuilt only when the resolved settings actually change (the
// settings themselves are already Redis-cached for 60s by
// policyCache.getDnsEngineSettings() — this just avoids reconstructing dns2
// clients on every single query when nothing changed).
let cachedKey   = null;
let ipv4Clients = [];
let ipv6Clients = [];

async function getClients() {
  const s = await policyCache.getDnsEngineSettings();
  const key = `${s.upstreamIpv4.join(',')}|${s.upstreamIpv6.join(',')}`;
  if (key !== cachedKey) {
    ipv4Clients = s.upstreamIpv4.map(addr => new DNS({ dns: addr, retries: 1, timeout: 4000 }));
    ipv6Clients = s.upstreamIpv6.map(addr => new DNS({ dns: addr, retries: 1, timeout: 4000 }));
    cachedKey = key;
  }
  return { ipv4Clients, ipv6Clients };
}

/**
 * Forward a query to the upstream resolver(s).
 *
 * upstreamIpv6 is an optional list, not a requirement — AAAA queries
 * already resolve correctly via the regular IPv4 resolvers for most
 * providers (a resolver's own address is just the transport you reach it
 * over, independent of which record type you ask it for; 8.8.8.8 answers
 * AAAA questions over plain IPv4 just fine). This only matters if an admin
 * specifically wants AAAA queries routed to different resolver(s).
 *
 * AAAA queries try the IPv6 list first (in order), then always fall
 * through to the IPv4 list (in order) — covers both "no IPv6 list
 * configured" and "every IPv6 resolver failed."
 * Returns a dns2 Packet (.answers/.authorities/.additionals).
 */
async function resolve(name, typeNum) {
  const typeName = TYPE_NAMES[typeNum] || 'A';
  const { ipv4Clients, ipv6Clients } = await getClients();

  if (typeName === 'AAAA') {
    for (const client of ipv6Clients) {
      try {
        return await client.resolve(name, typeName);
      } catch {
        // try the next configured resolver
      }
    }
  }

  let lastErr;
  for (const client of ipv4Clients) {
    try {
      return await client.resolve(name, typeName);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No upstream resolvers configured');
}

module.exports = { resolve };
