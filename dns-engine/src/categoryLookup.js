const redis  = require('./redis');
const { getDomainsToCheck } = require('./blocklistLoader');

const CATEGORY_KEY = 'classguard:domain:category';

/**
 * Look up the category for a domain (or its parent domains).
 * Uses the same parent-walk as blocklist: sub.reddit.com → reddit.com → (stop before TLD).
 * Returns the category slug string, or null if not categorized.
 *
 * Single Redis pipeline — one round-trip regardless of domain depth.
 */
async function getCategoryForDomain(domain) {
  const toCheck = getDomainsToCheck(domain);
  if (!toCheck.length) return null;

  const pipeline = redis.pipeline();
  for (const d of toCheck) {
    pipeline.hget(CATEGORY_KEY, d);
  }

  const results = await pipeline.exec();
  for (const [err, val] of results) {
    if (!err && val) return val;
  }
  return null;
}

module.exports = { getCategoryForDomain };
