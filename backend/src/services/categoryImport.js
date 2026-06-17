// categoryImport.js — Download and import UT1 / Shallalist domain category lists
// into Postgres (source of truth) and rebuild the Redis fast-path cache.

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execFile } = require('child_process');
const util     = require('util');
const axios    = require('axios');
const { query } = require('../db');
const redis    = require('../redis');

const execFileAsync = util.promisify(execFile);
const CATEGORY_KEY  = 'classguard:domain:category';
const STATUS_KEY    = 'classguard:category-sync:status';
const CHUNK         = 500;

// ---------------------------------------------------------------------------
// Sync status helpers — write to Redis so the UI can poll
// ---------------------------------------------------------------------------
async function setStatus(patch) {
  const raw = await redis.get(STATUS_KEY).catch(() => null);
  const current = raw ? JSON.parse(raw) : {};
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  await redis.set(STATUS_KEY, JSON.stringify(next), 'EX', 3600); // auto-expire after 1h
}

// Update a per-source nested status correctly (avoids flat-key spread bug)
async function setSourceStatus(slug, patch) {
  const raw = await redis.get(STATUS_KEY).catch(() => null);
  const current = raw ? JSON.parse(raw) : {};
  const sources = current.sources || {};
  const next = {
    ...current,
    sources: { ...sources, [slug]: { ...(sources[slug] || {}), ...patch } },
    updated_at: new Date().toISOString(),
  };
  await redis.set(STATUS_KEY, JSON.stringify(next), 'EX', 3600);
}

async function getStatus() {
  const raw = await redis.get(STATUS_KEY).catch(() => null);
  return raw ? JSON.parse(raw) : { running: false };
}

// UT1 category folder name → our slug
// UT1 uses many French folder names (drogue, alcool, armes, agressif, etc.)
const UT1_MAP = {
  'adult': 'adult', 'mixed_adult': 'adult', 'sexual_education': 'adult',
  'child': 'adult',
  'agressif': 'violence', 'violence': 'violence',
  'armes': 'weapons', 'weapons': 'weapons',
  'gambling': 'gambling',
  'drugs': 'drugs_alcohol', 'alcohol': 'drugs_alcohol',
  'drogue': 'drugs_alcohol', 'alcool': 'drugs_alcohol',  // French UT1 names
  'hate': 'hate_speech', 'sect': 'hate_speech',
  'phishing': 'phishing',
  'malware': 'malware', 'hacking': 'malware', 'ddos': 'malware', 'warez': 'torrent',
  'vpn': 'proxy_vpn', 'proxy': 'proxy_vpn', 'anonymizer': 'proxy_vpn',
  'redirector': 'proxy_vpn', 'strict_redirector': 'proxy_vpn', 'strong_redirector': 'proxy_vpn',
  'P2P': 'torrent', 'p2p': 'torrent', 'filehosting': 'torrent', 'download': 'torrent', 'upload': 'torrent',
  'dating': 'dating',
  'social_networks': 'social_media',
  'games': 'gaming', 'onlinegames': 'gaming',
  'audio-video': 'streaming', 'music': 'streaming', 'radio': 'streaming',
  'chat': 'messaging', 'webmail': 'messaging',
  'forums': 'forums', 'blog': 'forums',
  'shopping': 'shopping',
  'news': 'news', 'press': 'news',
  'sport': 'sports', 'sports': 'sports',
  'health': 'health', 'homeopathie': 'health', 'sante': 'health',
  'bank': 'finance', 'finance': 'finance', 'crypto-currency': 'finance', 'bitcoin': 'finance',
  'education': 'education', 'science': 'education',
  'searchengines': 'search',
  'publicite': 'ads_tracking', 'marketingware': 'ads_tracking', 'tricheur': 'other',
};

// Shallalist BL/<folder> → our slug
const SHALLA_MAP = {
  'adv': 'ads_tracking',
  'aggressive': 'violence',
  'alcohol': 'drugs_alcohol',
  'anonvpn': 'proxy_vpn',
  'artnude': 'adult',
  'chat': 'messaging',
  'dating': 'dating',
  'downloads': 'torrent',
  'drugs': 'drugs_alcohol',
  'education': 'education',
  'finance': 'finance',
  'forum': 'forums',
  'gambling': 'gambling',
  'hacking': 'malware',
  'models': 'adult',
  'news': 'news',
  'podcasts': 'streaming',
  'porn': 'adult',
  'radiotv': 'streaming',
  'redirector': 'proxy_vpn',
  'science': 'education',
  'searchengines': 'search',
  'sex': 'adult',
  'shopping': 'shopping',
  'socialnet': 'social_media',
  'spyware': 'malware',
  'sports': 'sports',
  'tracker': 'ads_tracking',
  'violence': 'violence',
  'warez': 'torrent',
  'weapons': 'weapons',
  'webphone': 'messaging',
  'webradio': 'streaming',
  'webmail': 'messaging',
};

// ---------------------------------------------------------------------------
// Download a URL to a temp file
// ---------------------------------------------------------------------------
async function downloadToFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 180_000,
    headers: { 'User-Agent': 'ClassGuard/1.0 (content filter; school district)' },
  });
  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Extract a .tar.gz to a directory using system tar (available in Alpine)
// ---------------------------------------------------------------------------
async function extractTarGz(srcFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', srcFile, '-C', destDir]);
}

// ---------------------------------------------------------------------------
// Walk a directory, yield {filePath, slug, fileType} for each mapped category.
// Prefers 'domains' file; falls back to 'urls' file when no domains file exists.
// ---------------------------------------------------------------------------
function* walkDomainFiles(baseDir, categoryMap) {
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = categoryMap[entry.name];
    if (!slug) continue;
    const domainsFile = path.join(baseDir, entry.name, 'domains');
    if (fs.existsSync(domainsFile)) {
      yield { filePath: domainsFile, slug, fileType: 'domains' };
    } else {
      const urlsFile = path.join(baseDir, entry.name, 'urls');
      if (fs.existsSync(urlsFile)) yield { filePath: urlsFile, slug, fileType: 'urls' };
    }
  }
}

// ---------------------------------------------------------------------------
// Parse a 'domains' file — one bare domain per line
// ---------------------------------------------------------------------------
function parseDomainFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => l && !l.startsWith('#') && l.includes('.') && l.length <= 253);
}

// ---------------------------------------------------------------------------
// Parse a 'urls' file — extract unique hostnames (strip path after first /)
// ---------------------------------------------------------------------------
function parseUrlFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const seen = new Set();
  const result = [];
  for (const line of text.split('\n')) {
    let l = line.trim().toLowerCase();
    if (!l || l.startsWith('#')) continue;
    l = l.replace(/^https?:\/\//, '');
    const host = l.split('/')[0];
    if (host && host.includes('.') && host.length <= 253 && !host.includes(' ') && !seen.has(host)) {
      seen.add(host);
      result.push(host);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bulk upsert domains into Postgres domain_categories
// Returns { inserted, skipped }
// ---------------------------------------------------------------------------
async function upsertDomains(pairs, source) {
  // Get category slug → id map
  const { rows: cats } = await query('SELECT id, slug FROM website_categories');
  const catIdMap = Object.fromEntries(cats.map(c => [c.slug, c.id]));

  let inserted = 0;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    const domains = chunk.map(p => p.domain);
    const catIds  = chunk.map(p => catIdMap[p.slug]);
    const sources = chunk.map(() => source);

    // Skip pairs where category doesn't exist
    const valid = chunk.filter((_, j) => catIds[j]);
    if (!valid.length) continue;

    const vDomains = valid.map(p => p.domain);
    const vCatIds  = valid.map(p => catIdMap[p.slug]);

    await query(
      `INSERT INTO domain_categories (domain, category_id, source, confidence)
       SELECT unnest($1::text[]), unnest($2::uuid[]), $3, 90
       ON CONFLICT (domain, category_id) DO UPDATE SET source = EXCLUDED.source`,
      [vDomains, vCatIds, source]
    );
    inserted += valid.length;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Rebuild the Redis hash cache from Postgres
// (one HSET per domain with highest-confidence category)
// ---------------------------------------------------------------------------
async function rebuildRedisCache() {
  console.log('[category-import] rebuilding Redis cache from Postgres...');

  // Get the primary category for each domain (highest confidence, prefer manual overrides)
  const { rows } = await query(`
    SELECT dc.domain, wc.slug
    FROM domain_categories dc
    JOIN website_categories wc ON wc.id = dc.category_id
    WHERE NOT EXISTS (
      SELECT 1 FROM domain_categories dc2
      WHERE dc2.domain = dc.domain
        AND (dc2.confidence > dc.confidence OR (dc2.confidence = dc.confidence AND dc2.is_override AND NOT dc.is_override))
    )
  `);

  // Clear existing cache
  await redis.del(CATEGORY_KEY);

  // Rebuild in chunks
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const pipeline = redis.pipeline();
    for (const { domain, slug } of chunk) {
      pipeline.hset(CATEGORY_KEY, domain, slug);
    }
    await pipeline.exec();
  }

  console.log(`[category-import] Redis cache rebuilt — ${rows.length} domains`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Import a single source (ut1 or shallalist)
// ---------------------------------------------------------------------------
async function importSource(sourceSlug) {
  const { rows: [src] } = await query(
    'SELECT * FROM category_sources WHERE slug = $1 AND is_active = true',
    [sourceSlug]
  );
  if (!src) throw new Error(`Source "${sourceSlug}" not found or inactive`);

  const tmpDir  = path.join(os.tmpdir(), `classguard-${sourceSlug}-${Date.now()}`);
  const tarFile = path.join(os.tmpdir(), `classguard-${sourceSlug}.tar.gz`);

  await setSourceStatus(sourceSlug, { phase: 'downloading', started_at: new Date().toISOString() });
  console.log(`[category-import] downloading ${src.name} from ${src.url}`);
  await downloadToFile(src.url, tarFile);

  const fileSizeMb = (fs.statSync(tarFile).size / 1024 / 1024).toFixed(1);
  await setSourceStatus(sourceSlug, { phase: 'extracting', file_size_mb: fileSizeMb });
  console.log(`[category-import] extracting ${sourceSlug} (${fileSizeMb} MB)`);
  await extractTarGz(tarFile, tmpDir);
  fs.unlinkSync(tarFile);

  const categoryMap  = sourceSlug === 'ut1' ? UT1_MAP : SHALLA_MAP;
  const subDirName   = sourceSlug === 'ut1' ? 'blacklists' : 'BL';
  const baseDir      = path.join(tmpDir, subDirName);
  const actualBase   = fs.existsSync(baseDir)
    ? baseDir
    : path.join(tmpDir, fs.readdirSync(tmpDir)[0] || '');

  await setSourceStatus(sourceSlug, { phase: 'parsing', file_size_mb: fileSizeMb });
  console.log(`[category-import] parsing domain files from ${actualBase}`);
  const pairs = [];
  for (const { filePath, slug, fileType } of walkDomainFiles(actualBase, categoryMap)) {
    const domains = fileType === 'urls' ? parseUrlFile(filePath) : parseDomainFile(filePath);
    for (const domain of domains) {
      pairs.push({ domain, slug });
    }
  }

  await setSourceStatus(sourceSlug, { phase: 'importing', pairs: pairs.length });
  console.log(`[category-import] ${pairs.length} domain-category pairs parsed, upserting...`);
  const inserted = await upsertDomains(pairs, sourceSlug);

  await query(
    `UPDATE category_sources SET last_synced_at = NOW(), domain_count = $1 WHERE slug = $2`,
    [inserted, sourceSlug]
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });

  await setSourceStatus(sourceSlug, { phase: 'done', domains: inserted });
  console.log(`[category-import] ${sourceSlug} done — ${inserted} domains imported`);
  return inserted;
}

// ---------------------------------------------------------------------------
// Full sync: import all active sources then rebuild Redis
// ---------------------------------------------------------------------------
async function syncAll() {
  const { rows: sources } = await query(
    'SELECT slug FROM category_sources WHERE is_active = true'
  );

  await setStatus({
    running: true,
    started_at: new Date().toISOString(),
    completed_at: null,
    error: null,
    phase: 'starting',
    sources: Object.fromEntries(sources.map(s => [s.slug, { phase: 'queued' }])),
  });

  const results = {};
  for (const { slug } of sources) {
    await setStatus({ phase: `syncing_${slug}` });
    try {
      results[slug] = await importSource(slug);
    } catch (e) {
      console.error(`[category-import] ${slug} failed:`, e.message);
      results[slug] = { error: e.message };
      await setSourceStatus(slug, { phase: 'error', error: e.message });
    }
  }

  await setStatus({ phase: 'rebuilding_cache' });
  const cacheSize = await rebuildRedisCache();

  await setStatus({
    running: false,
    phase: 'done',
    completed_at: new Date().toISOString(),
    cache_size: cacheSize,
  });
  return { sources: results, cacheSize };
}

// ---------------------------------------------------------------------------
// Classify uncategorized domains from recent DNS logs using keyword matching
// ---------------------------------------------------------------------------
async function classifyRecentDomains(limit = 500) {
  const { classify } = require('./domainClassifier');
  const { rows: cats } = await query('SELECT id, slug FROM website_categories');
  const catIdMap = Object.fromEntries(cats.map(c => [c.slug, c.id]));

  // Domains seen in the last 24h not yet categorized
  const { rows } = await query(`
    SELECT DISTINCT dl.domain
    FROM dns_logs dl
    WHERE dl.queried_at > NOW() - INTERVAL '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM domain_categories dc WHERE dc.domain = dl.domain
      )
    ORDER BY dl.domain
    LIMIT $1
  `, [limit]);

  let classified = 0;
  const toInsert = [];
  for (const { domain } of rows) {
    const result = classify(domain);
    if (result && catIdMap[result.slug]) {
      toInsert.push({ domain, slug: result.slug, confidence: result.confidence });
    }
  }

  if (toInsert.length) {
    const { rows: inserted } = await query(
      `INSERT INTO domain_categories (domain, category_id, source, confidence)
       SELECT unnest($1::text[]), unnest($2::uuid[]), 'keyword', unnest($3::smallint[])
       ON CONFLICT (domain, category_id) DO NOTHING
       RETURNING id`,
      [
        toInsert.map(r => r.domain),
        toInsert.map(r => catIdMap[r.slug]),
        toInsert.map(r => r.confidence),
      ]
    );
    classified = inserted.length;

    // Update Redis for newly classified domains
    if (classified) {
      const pipeline = redis.pipeline();
      for (const r of toInsert) {
        pipeline.hset(CATEGORY_KEY, r.domain, r.slug);
      }
      await pipeline.exec();
    }
  }

  console.log(`[category-import] keyword classifier: ${classified}/${rows.length} domains classified`);
  return classified;
}

module.exports = { syncAll, importSource, rebuildRedisCache, classifyRecentDomains, getStatus };
