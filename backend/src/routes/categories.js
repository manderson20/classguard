const express  = require('express');
const { query } = require('../db');
const redis    = require('../redis');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { classify }       = require('../services/domainClassifier');
const { syncAll, importSource, rebuildRedisCache, classifyRecentDomains, getStatus } = require('../services/categoryImport');

const router    = express.Router();
const adminOnly = [authenticate, requireMinRole('admin')];
const CATEGORY_KEY = 'classguard:domain:category';

// ---------------------------------------------------------------------------
// GET /api/v1/categories
// All categories with domain counts
// ---------------------------------------------------------------------------
router.get('/', ...adminOnly, async (req, res) => {
  const { rows } = await query(`
    SELECT wc.*,
           COUNT(dc.id)::int AS domain_count
    FROM website_categories wc
    LEFT JOIN domain_categories dc ON dc.category_id = wc.id
    GROUP BY wc.id
    ORDER BY wc.sort_order
  `);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// GET /api/v1/categories/sources
// List import sources with sync status
// ---------------------------------------------------------------------------
router.get('/sources', ...adminOnly, async (req, res) => {
  const { rows } = await query('SELECT * FROM category_sources ORDER BY name');
  const cacheSize = await redis.hlen(CATEGORY_KEY).catch(() => 0);
  res.json({ sources: rows, cacheSize });
});

// ---------------------------------------------------------------------------
// GET /api/v1/categories/sync-status
// Poll the current sync status from Redis
// ---------------------------------------------------------------------------
router.get('/sync-status', ...adminOnly, async (req, res) => {
  const status = await getStatus();
  res.json(status);
});

// ---------------------------------------------------------------------------
// POST /api/v1/categories/sync
// Trigger full UT1 + Shallalist sync (async, returns immediately)
// ---------------------------------------------------------------------------
router.post('/sync', ...adminOnly, async (req, res) => {
  const existing = await getStatus();
  if (existing?.running) {
    return res.status(409).json({ error: 'A sync is already running', status: existing });
  }
  const { source } = req.body;
  res.json({ status: 'sync started', source: source || 'all' });
  (source ? importSource(source) : syncAll())
    .then(r => console.log('[categories] sync complete:', r))
    .catch(e => console.error('[categories] sync error:', e.message));
});

// ---------------------------------------------------------------------------
// POST /api/v1/categories/rebuild-cache
// Rebuild Redis hash from Postgres without re-downloading
// ---------------------------------------------------------------------------
router.post('/rebuild-cache', ...adminOnly, async (req, res) => {
  const count = await rebuildRedisCache();
  res.json({ ok: true, cacheSize: count });
});

// ---------------------------------------------------------------------------
// POST /api/v1/categories/classify-recent
// Run keyword classifier against uncategorized DNS log domains
// ---------------------------------------------------------------------------
router.post('/classify-recent', ...adminOnly, async (req, res) => {
  const classified = await classifyRecentDomains(req.body.limit || 500);
  res.json({ classified });
});

// ---------------------------------------------------------------------------
// GET /api/v1/categories/lookup?domain=...
// Look up a domain's category (Redis fast path, fallback to keyword)
// ---------------------------------------------------------------------------
router.get('/lookup', ...adminOnly, async (req, res) => {
  const domain = (req.query.domain || '').toLowerCase().trim().replace(/\.$/, '');
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  // Walk domain parts (sub.domain.com → check sub.domain.com, domain.com)
  const parts  = domain.split('.');
  const checks = [];
  for (let i = 0; i < parts.length - 1; i++) {
    checks.push(parts.slice(i).join('.'));
  }

  // Check Redis
  const pipeline = redis.pipeline();
  for (const d of checks) pipeline.hget(CATEGORY_KEY, d);
  const redisResults = await pipeline.exec();
  const redisHit = redisResults.find(([err, val]) => !err && val);
  const redisCat = redisHit?.[1] || null;

  // Check Postgres for full record
  const { rows: pgRows } = await query(`
    SELECT dc.domain, dc.source, dc.confidence, dc.is_override, dc.created_at,
           wc.slug, wc.name AS category_name, wc.risk_level
    FROM domain_categories dc
    JOIN website_categories wc ON wc.id = dc.category_id
    WHERE dc.domain = ANY($1)
    ORDER BY dc.confidence DESC, dc.is_override DESC
    LIMIT 5
  `, [checks]);

  // Keyword fallback
  const keywordResult = !pgRows.length ? classify(domain) : null;

  res.json({
    domain,
    category:        redisCat || pgRows[0]?.slug || keywordResult?.slug || null,
    category_name:   pgRows[0]?.category_name || null,
    source:          pgRows[0]?.source || (keywordResult ? 'keyword' : null),
    confidence:      pgRows[0]?.confidence || keywordResult?.confidence || null,
    is_override:     pgRows[0]?.is_override || false,
    risk_level:      pgRows[0]?.risk_level || null,
    records:         pgRows,
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/categories/override
// Manually set (or remove) a domain's category
// ---------------------------------------------------------------------------
router.post('/override', ...adminOnly, async (req, res) => {
  const { domain, category_slug, remove = false } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const clean = domain.toLowerCase().trim();

  if (remove) {
    await query('DELETE FROM domain_categories WHERE domain = $1 AND is_override = true', [clean]);
    await redis.hdel(CATEGORY_KEY, clean);
    return res.json({ ok: true, removed: true });
  }

  if (!category_slug) return res.status(400).json({ error: 'category_slug is required' });

  const { rows: [cat] } = await query(
    'SELECT id FROM website_categories WHERE slug = $1', [category_slug]
  );
  if (!cat) return res.status(404).json({ error: 'Category not found' });

  // Remove any non-override records for this domain first to avoid conflicts
  await query(
    'DELETE FROM domain_categories WHERE domain = $1 AND is_override = false',
    [clean]
  );

  const { rows: [row] } = await query(`
    INSERT INTO domain_categories (domain, category_id, source, confidence, is_override)
    VALUES ($1, $2, 'manual', 100, true)
    ON CONFLICT (domain, category_id) DO UPDATE SET
      source = 'manual', confidence = 100, is_override = true
    RETURNING *
  `, [clean, cat.id]);

  await redis.hset(CATEGORY_KEY, clean, category_slug);
  res.json({ ok: true, record: row });
});

// ---------------------------------------------------------------------------
// GET /api/v1/categories/:slug/domains?page=&limit=&search=
// Browse domains in a category
// ---------------------------------------------------------------------------
router.get('/:slug/domains', ...adminOnly, async (req, res) => {
  const { rows: [cat] } = await query(
    'SELECT id FROM website_categories WHERE slug = $1', [req.params.slug]
  );
  if (!cat) return res.status(404).json({ error: 'Category not found' });

  const page   = Math.max(1, parseInt(req.query.page, 10)  || 1);
  const limit  = Math.min(200, parseInt(req.query.limit, 10) || 50);
  const search = req.query.search ? `%${req.query.search}%` : null;
  const offset = (page - 1) * limit;

  const where = search ? 'AND dc.domain ILIKE $3' : '';
  const vals  = search ? [cat.id, limit, search, offset] : [cat.id, limit, offset];
  const offParam = search ? '$4' : '$3';

  const { rows } = await query(`
    SELECT dc.domain, dc.source, dc.confidence, dc.is_override, dc.created_at
    FROM domain_categories dc
    WHERE dc.category_id = $1 ${where}
    ORDER BY dc.is_override DESC, dc.confidence DESC, dc.domain
    LIMIT $2 OFFSET ${offParam}
  `, vals);

  const { rows: [cnt] } = await query(
    `SELECT COUNT(*) AS total FROM domain_categories WHERE category_id = $1 ${search ? 'AND domain ILIKE $2' : ''}`,
    search ? [cat.id, search] : [cat.id]
  );

  res.json({ domains: rows, total: parseInt(cnt.total, 10), page, limit });
});

// ---------------------------------------------------------------------------
// GET /api/v1/categories/policy-rules?policy_id=
// GET /api/v1/categories/policy-rules (all)
// ---------------------------------------------------------------------------
router.get('/policy-rules', ...adminOnly, async (req, res) => {
  const { policy_id } = req.query;
  const where = policy_id ? 'WHERE pcr.policy_id = $1' : '';
  const vals  = policy_id ? [policy_id] : [];
  const { rows } = await query(`
    SELECT pcr.*, wc.slug, wc.name AS category_name, wc.risk_level,
           p.name AS policy_name
    FROM policy_category_rules pcr
    JOIN website_categories wc ON wc.id = pcr.category_id
    JOIN policies p            ON p.id  = pcr.policy_id
    ${where}
    ORDER BY p.name, wc.sort_order
  `, vals);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// PUT /api/v1/categories/policy-rules
// Upsert a category rule for a policy
// ---------------------------------------------------------------------------
router.put('/policy-rules', ...adminOnly, async (req, res) => {
  const { policy_id, category_slug, action } = req.body;
  if (!policy_id || !category_slug || !action) {
    return res.status(400).json({ error: 'policy_id, category_slug, action are required' });
  }
  if (!['block','allow','monitor'].includes(action)) {
    return res.status(400).json({ error: 'action must be block, allow, or monitor' });
  }

  const { rows: [cat] } = await query(
    'SELECT id FROM website_categories WHERE slug = $1', [category_slug]
  );
  if (!cat) return res.status(404).json({ error: 'Category not found' });

  const { rows: [row] } = await query(`
    INSERT INTO policy_category_rules (policy_id, category_id, action)
    VALUES ($1, $2, $3)
    ON CONFLICT (policy_id, category_id) DO UPDATE SET action = EXCLUDED.action
    RETURNING *
  `, [policy_id, cat.id, action]);

  // Invalidate Redis policy cache for all users on this policy
  const { rows: users } = await query(
    `SELECT pa.target_id AS student_id FROM policy_assignments pa WHERE pa.policy_id = $1 AND pa.target_type = 'student'`,
    [policy_id]
  );
  if (users.length) {
    const pipeline = redis.pipeline();
    for (const { student_id } of users) {
      pipeline.del(`student:policy:${student_id}`);
    }
    await pipeline.exec();
  }

  res.json(row);
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/categories/policy-rules/:id
// ---------------------------------------------------------------------------
router.delete('/policy-rules/:id', ...adminOnly, async (req, res) => {
  const { rows: [row] } = await query(
    'DELETE FROM policy_category_rules WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: row });
});

module.exports = router;
