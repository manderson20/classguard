const redis  = require('./redis');

const BLOCKLIST_KEY = 'classguard:blocklist';

/**
 * Build the list of domains to check for a given query name.
 * For sub.reddit.com we check: sub.reddit.com AND reddit.com
 * We stop before the TLD so we never match 'com' alone.
 */
function getDomainsToCheck(domain) {
  const lower  = domain.toLowerCase().replace(/\.$/, ''); // strip trailing dot
  const parts  = lower.split('.');
  const checks = [];
  // Walk from the full name up to (but not including) the TLD
  for (let i = 0; i < parts.length - 1; i++) {
    checks.push(parts.slice(i).join('.'));
  }
  return checks;
}

/**
 * Returns true if the domain (or any of its parent domains) is on the blocklist.
 * Uses a Redis pipeline to batch all SISMEMBER calls into one round-trip.
 */
async function isBlocked(domain) {
  const toCheck = getDomainsToCheck(domain);
  if (toCheck.length === 0) return false;

  const pipeline = redis.pipeline();
  for (const d of toCheck) {
    pipeline.sismember(BLOCKLIST_KEY, d);
  }

  const results = await pipeline.exec();
  return results.some(([err, hit]) => !err && hit === 1);
}

/**
 * Returns the number of entries in the master blocklist.
 */
async function getCount() {
  return redis.scard(BLOCKLIST_KEY);
}

module.exports = { isBlocked, getCount, getDomainsToCheck };
