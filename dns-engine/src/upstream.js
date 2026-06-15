const DNS    = require('dns2');
const config = require('./config');

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

const primaryClient   = new DNS({ dns: config.dns.upstreamPrimary,   retries: 1, timeout: 4000 });
const secondaryClient = new DNS({ dns: config.dns.upstreamSecondary, retries: 1, timeout: 4000 });

/**
 * Forward a query to the upstream resolver.
 * Falls back to the secondary if the primary times out or errors.
 * Returns a dns2 Packet (with .answers, .authorities, .additionals).
 */
async function resolve(name, typeNum) {
  const typeName = TYPE_NAMES[typeNum] || 'A';
  try {
    return await primaryClient.resolve(name, typeName);
  } catch {
    return await secondaryClient.resolve(name, typeName);
  }
}

module.exports = { resolve };
