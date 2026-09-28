const readline = require('readline');
const axios    = require('axios');
const redis    = require('../redis');
const { query } = require('../db');

const MASTER_KEY  = 'classguard:blocklist';
const BATCH_SIZE  = 1000;  // domains per SADD call

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isValidDomain(d) {
  if (!d || d.length > 253) return false;
  if (d.startsWith('.') || d.endsWith('.')) return false;
  if (!d.includes('.')) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(d);
}

const SKIP_HOSTS = new Set(['localhost', 'localhost.localdomain', 'local', '0.0.0.0', '::1', 'broadcasthost']);

function parseLine(raw, format) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;

  let domain;

  switch (format) {
    case 'hosts': {
      // '0.0.0.0 reddit.com'  or  '127.0.0.1 reddit.com'
      const parts = line.split(/\s+/);
      if (parts.length < 2) return null;
      domain = parts[1].toLowerCase().split('#')[0].trim();
      if (SKIP_HOSTS.has(domain)) return null;
      break;
    }
    case 'dnsmasq': {
      // 'address=/domain.com/'  'address=/domain.com/0.0.0.0'  'local=/domain.com/'
      const m = line.match(/^(?:address|local|server)=\/([^/]+)\//);
      if (!m) return null;
      domain = m[1].toLowerCase();
      break;
    }
    case 'url_list': {
      // Securly-style URL patterns: '*.example.com/', 'example.com/', full URLs.
      // DNS filtering is host-level only, so entries scoped to a specific path
      // are skipped rather than over-blocking the whole host.
      const stripped = line.split(/\s+/)[0].toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^\*\./, '');
      const slash = stripped.indexOf('/');
      if (slash !== -1 && slash < stripped.length - 1) return null;
      domain = slash === -1 ? stripped : stripped.slice(0, slash);
      break;
    }
    case 'domain_list':
    default:
      domain = line.split('#')[0].trim().toLowerCase();
      break;
  }

  return domain && isValidDomain(domain) ? domain : null;
}

// ---------------------------------------------------------------------------
// Download + parse (streaming — handles files with millions of lines)
// ---------------------------------------------------------------------------

async function fetchAndParse(source) {
  const { data: stream } = await axios.get(source.url, {
    responseType: 'stream',
    timeout:      120_000,
    headers:      { 'User-Agent': 'ClassGuard-BlocklistSync/1.0' },
  });

  const rl      = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const domains = new Set();

  for await (const line of rl) {
    const d = parseLine(line, source.format);
    if (d) domains.add(d);
  }

  // Deduped, so domain_count matches the Redis set cardinality (url_list
  // sources commonly list each domain twice: '*.x.com/' and 'x.com/').
  return [...domains];
}

// ---------------------------------------------------------------------------
// Redis storage — atomic replace using a temp key + RENAME
// ---------------------------------------------------------------------------

async function storeInRedis(key, domains) {
  const tmpKey = `${key}:tmp`;
  await redis.del(tmpKey);

  for (let i = 0; i < domains.length; i += BATCH_SIZE) {
    const batch = domains.slice(i, i + BATCH_SIZE);
    await redis.sadd(tmpKey, ...batch);
  }

  if (domains.length > 0) {
    await redis.rename(tmpKey, key);
  } else {
    await redis.del(key);
    await redis.del(tmpKey);
  }
}

// ---------------------------------------------------------------------------
// Master list rebuild — SUNIONSTORE of all active source sets
// ---------------------------------------------------------------------------

async function rebuildMasterList() {
  const { rows } = await query(
    'SELECT id FROM blocklist_sources WHERE is_active = true'
  );

  if (rows.length === 0) {
    await redis.del(MASTER_KEY);
    return 0;
  }

  const sourceKeys = rows.map(r => `${MASTER_KEY}:${r.id}`);
  await redis.sunionstore(MASTER_KEY, ...sourceKeys);

  return redis.scard(MASTER_KEY);
}

// ---------------------------------------------------------------------------
// Sync a single source
// ---------------------------------------------------------------------------

// recordStats=false skips the blocklist_sources stats UPDATE — for a standby
// filling its own Redis, whose local Postgres is a read-only replica.
async function syncSource(sourceId, { recordStats = true } = {}) {
  const { rows } = await query(
    'SELECT * FROM blocklist_sources WHERE id = $1',
    [sourceId]
  );

  if (!rows[0]) throw new Error(`Blocklist source ${sourceId} not found`);
  const source = rows[0];

  console.log(`[blocklist] syncing "${source.name}" (${source.url})`);

  const domains = await fetchAndParse(source);
  console.log(`[blocklist] "${source.name}" — ${domains.length} domains parsed`);

  await storeInRedis(`${MASTER_KEY}:${sourceId}`, domains);

  // Update DB stats
  if (recordStats) await query(
    `UPDATE blocklist_sources
     SET domain_count   = $1,
         last_synced_at = NOW()
     WHERE id = $2`,
    [domains.length, sourceId]
  );

  const masterCount = await rebuildMasterList();
  console.log(`[blocklist] master list rebuilt — ${masterCount} total domains`);

  return { sourceId, domainCount: domains.length, masterCount };
}

// ---------------------------------------------------------------------------
// Sync all active sources
// ---------------------------------------------------------------------------

async function syncAll({ recordStats = true } = {}) {
  const { rows } = await query(
    'SELECT id, name FROM blocklist_sources WHERE is_active = true ORDER BY name'
  );

  console.log(`[blocklist] starting full sync — ${rows.length} active sources`);

  const results = [];
  for (const source of rows) {
    try {
      const result = await syncSource(source.id, { recordStats });
      results.push({ ...result, status: 'ok' });
    } catch (err) {
      console.error(`[blocklist] failed to sync "${source.name}":`, err.message);
      results.push({ sourceId: source.id, status: 'error', error: err.message });
    }
  }

  console.log('[blocklist] full sync complete');
  return results;
}

// ---------------------------------------------------------------------------
// Fill in any active source whose Redis set is missing, then rebuild the
// master list. Runs on EVERY node: each node's DNS engine reads its own
// Redis, but the scheduled sync only runs on the RUN_CRON_JOBS node, so a
// standby (or a node whose Redis was flushed) otherwise has no blocklist.
// ---------------------------------------------------------------------------

async function reconcileRedis() {
  const { rows } = await query(
    'SELECT id, name FROM blocklist_sources WHERE is_active = true ORDER BY name'
  );
  for (const source of rows) {
    if (await redis.exists(`${MASTER_KEY}:${source.id}`)) continue;
    try {
      await syncSource(source.id, { recordStats: false });
    } catch (err) {
      console.error(`[blocklist] reconcile: failed to sync "${source.name}":`, err.message);
    }
  }
  return rebuildMasterList();
}

// ---------------------------------------------------------------------------
// Remove a source from Redis and rebuild master
// ---------------------------------------------------------------------------

async function removeSource(sourceId) {
  await redis.del(`${MASTER_KEY}:${sourceId}`);
  return rebuildMasterList();
}

module.exports = { fetchAndParse, syncSource, syncAll, reconcileRedis, rebuildMasterList, removeSource };
