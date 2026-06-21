const redis       = require('./redis');
const policyCache = require('./policyCache');

const PREFIX = 'dns:cache:';

function cacheKey(domain, type) {
  return `${PREFIX}${domain.toLowerCase()}:${type}`;
}

/**
 * Returns cached answers array or null if not cached.
 */
async function get(domain, type) {
  const raw = await redis.get(cacheKey(domain, type));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Caches the answers array.
 * TTL is the minimum record TTL from the answers (floored to 1s),
 * capped to the cache_ttl setting (Settings -> DNS & Retention; live-read
 * via policyCache, same as the upstream/block-page settings).
 */
async function set(domain, type, answers) {
  if (!answers || answers.length === 0) return;

  const { cacheTtl } = await policyCache.getDnsEngineSettings();
  const minTtl = answers.reduce((min, a) => Math.min(min, a.ttl ?? cacheTtl), cacheTtl);
  const ttl    = Math.max(1, Math.min(minTtl, cacheTtl));

  await redis.set(cacheKey(domain, type), JSON.stringify(answers), 'EX', ttl);
}

async function invalidate(domain, type) {
  await redis.del(cacheKey(domain, type));
}

module.exports = { get, set, invalidate };
