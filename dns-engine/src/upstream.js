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
// policyCache.getDnsEngineSettings() — this just avoids reconstructing a
// dns2 client on every single query when nothing changed).
let cachedKey = null;
let primaryClient   = null;
let secondaryClient = null;
let ipv6Client       = null;

async function getClients() {
  const s = await policyCache.getDnsEngineSettings();
  const key = `${s.upstreamPrimary}|${s.upstreamSecondary}|${s.upstreamIpv6}`;
  if (key !== cachedKey) {
    primaryClient   = new DNS({ dns: s.upstreamPrimary,   retries: 1, timeout: 4000 });
    secondaryClient = new DNS({ dns: s.upstreamSecondary, retries: 1, timeout: 4000 });
    ipv6Client      = s.upstreamIpv6 ? new DNS({ dns: s.upstreamIpv6, retries: 1, timeout: 4000 }) : null;
    cachedKey = key;
  }
  return { primaryClient, secondaryClient, ipv6Client };
}

/**
 * Forward a query to the upstream resolver.
 *
 * upstreamIpv6 is an optional override, not a requirement — AAAA queries
 * already resolve correctly via the regular primary/secondary resolvers
 * (a resolver's own address is just the transport you reach it over,
 * independent of which record type you ask it for; 8.8.8.8 answers AAAA
 * questions over plain IPv4 just fine). This only matters if an admin
 * specifically wants AAAA queries routed to a *different* resolver.
 *
 * Falls back to primary -> secondary if the chosen client times out/errors.
 * Returns a dns2 Packet (with .answers, .authorities, .additionals).
 */
async function resolve(name, typeNum) {
  const typeName = TYPE_NAMES[typeNum] || 'A';
  const { primaryClient, secondaryClient, ipv6Client } = await getClients();

  if (typeName === 'AAAA' && ipv6Client) {
    try {
      return await ipv6Client.resolve(name, typeName);
    } catch {
      // fall through to the regular primary/secondary below
    }
  }

  try {
    return await primaryClient.resolve(name, typeName);
  } catch {
    return await secondaryClient.resolve(name, typeName);
  }
}

module.exports = { resolve };
