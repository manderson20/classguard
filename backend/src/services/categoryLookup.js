const redis = require('../redis');

// Mirrors dns-engine/src/categoryLookup.js exactly — same Redis hash
// (classguard:domain:category), populated by the same blocklist/category
// import job dns-engine reads from. Duplicated rather than imported since
// backend and dns-engine are separate services/containers with no shared
// module path; the lookup itself is a handful of lines.
const CATEGORY_KEY = 'classguard:domain:category';

function getDomainsToCheck(domain) {
  const lower  = domain.toLowerCase().replace(/\.$/, '');
  const parts  = lower.split('.');
  const checks = [];
  for (let i = 0; i < parts.length - 1; i++) {
    checks.push(parts.slice(i).join('.'));
  }
  return checks;
}

async function getCategoryForDomain(domain) {
  const toCheck = getDomainsToCheck(domain);
  if (!toCheck.length) return null;

  const pipeline = redis.pipeline();
  for (const d of toCheck) pipeline.hget(CATEGORY_KEY, d);

  const results = await pipeline.exec();
  for (const [err, val] of results) {
    if (!err && val) return val;
  }
  return null;
}

module.exports = { getCategoryForDomain };
