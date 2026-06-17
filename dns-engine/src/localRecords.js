// localRecords.js — Authoritative local DNS record lookup via Redis.
// Records are managed in the ClassGuard API and cached here for sub-ms lookups.

const redis = require('./redis');

const RECORDS_KEY = 'classguard:dns:local:records'; // Hash: "{TYPE}:{fqdn}" → JSON answers
const ZONES_KEY   = 'classguard:dns:local:zones';   // Set of zone names we're authoritative for

const TYPE_NAMES = {
  1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA',
  12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV',
};

// Check if we're authoritative for any zone that covers this domain
async function isLocalZone(domain) {
  const zones = await redis.smembers(ZONES_KEY).catch(() => []);
  return zones.some(z => domain === z || domain.endsWith(`.${z}`));
}

// Resolve a local DNS query.
// Returns:
//   Array of answer objects — found (may be empty = NXDOMAIN within our zone)
//   null — not our zone, caller should proceed with normal pipeline
async function lookupLocal(domain, typeNum) {
  const typeName = TYPE_NAMES[typeNum];
  if (!typeName) return null;

  const authoritative = await isLocalZone(domain).catch(() => false);
  if (!authoritative) return null;

  // Check exact match for the requested type
  const raw = await redis.hget(RECORDS_KEY, `${typeName}:${domain}`).catch(() => null);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }

  // For A queries: check if we have a CNAME and optionally chase it locally
  if (typeNum === 1) {
    const cnameRaw = await redis.hget(RECORDS_KEY, `CNAME:${domain}`).catch(() => null);
    if (cnameRaw) {
      try {
        const cnameAnswers = JSON.parse(cnameRaw);
        const target = cnameAnswers[0]?.domain;
        if (target) {
          // Try to resolve the CNAME target locally as well
          const targetRaw = await redis.hget(RECORDS_KEY, `A:${target}`).catch(() => null);
          const targetAnswers = targetRaw ? JSON.parse(targetRaw) : [];
          return [...cnameAnswers, ...targetAnswers];
        }
        return cnameAnswers;
      } catch {}
    }
  }

  // Zone matches but no record found — return empty (signals NXDOMAIN/NODATA to caller)
  return [];
}

module.exports = { lookupLocal };
