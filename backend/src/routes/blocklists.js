const express = require('express');
const redis   = require('../redis');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { syncSource, removeSource } = require('../services/blocklistSync');

const router = express.Router();

const adminOnly = [authenticate, requireMinRole('admin')];

const VALID_FORMATS    = ['hosts', 'domain_list', 'dnsmasq'];
const MASTER_KEY       = 'classguard:blocklist';
const PREVIEW_SAMPLE   = 50;

// ---------------------------------------------------------------------------
// GET /api/v1/blocklists
// List all sources with live Redis domain counts
// ---------------------------------------------------------------------------
router.get('/', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, url, format, category, is_active,
              sync_schedule, last_synced_at, domain_count, created_at
       FROM blocklist_sources
       ORDER BY name`
    );

    // Fetch live Redis counts in parallel
    const pipeline = redis.pipeline();
    for (const row of rows) {
      pipeline.scard(`${MASTER_KEY}:${row.id}`);
    }
    const counts = await pipeline.exec();

    const masterCount = await redis.scard(MASTER_KEY);

    const sources = rows.map((row, i) => ({
      ...row,
      redis_count: counts[i]?.[1] ?? 0,
    }));

    return res.json({ sources, masterCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/blocklists
// Add a new blocklist source
// ---------------------------------------------------------------------------
router.post('/', ...adminOnly, async (req, res) => {
  const { name, url, format = 'domain_list', category = 'custom', sync_schedule = 'daily' } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }
  if (!VALID_FORMATS.includes(format)) {
    return res.status(400).json({ error: `format must be one of: ${VALID_FORMATS.join(', ')}` });
  }

  try {
    new URL(url); // validate URL
  } catch {
    return res.status(400).json({ error: 'url is not a valid URL' });
  }

  try {
    const { rows } = await query(
      `INSERT INTO blocklist_sources (name, url, format, category, sync_schedule, is_active)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING *`,
      [name, url, format, category, sync_schedule]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A source with this URL already exists' });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/blocklists/:id
// Single source detail
// ---------------------------------------------------------------------------
router.get('/:id', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM blocklist_sources WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    const redisCount = await redis.scard(`${MASTER_KEY}:${rows[0].id}`);
    return res.json({ ...rows[0], redis_count: redisCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/blocklists/:id
// Update a source (name, category, schedule, active state)
// ---------------------------------------------------------------------------
router.put('/:id', ...adminOnly, async (req, res) => {
  const { name, category, sync_schedule, is_active } = req.body;

  try {
    const { rows } = await query(
      `UPDATE blocklist_sources
       SET name          = COALESCE($1, name),
           category      = COALESCE($2, category),
           sync_schedule = COALESCE($3, sync_schedule),
           is_active     = COALESCE($4, is_active)
       WHERE id = $5
       RETURNING *`,
      [name, category, sync_schedule, is_active, req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/blocklists/:id
// Remove source from DB + Redis, rebuild master list
// ---------------------------------------------------------------------------
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await query(
      'DELETE FROM blocklist_sources WHERE id = $1 RETURNING id, name',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    const masterCount = await removeSource(req.params.id);
    return res.json({ deleted: rows[0], masterCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/blocklists/:id/sync
// Trigger an immediate sync for this source
// ---------------------------------------------------------------------------
router.post('/:id/sync', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id FROM blocklist_sources WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    // Run sync asynchronously so the HTTP response returns quickly
    syncSource(req.params.id)
      .then(result => console.log(`[blocklist] manual sync complete:`, result))
      .catch(err  => console.error(`[blocklist] manual sync error:`, err.message));

    return res.json({ status: 'sync started', sourceId: req.params.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/blocklists/:id/preview
// Return a random sample of up to 50 domains from this source's Redis SET
// ---------------------------------------------------------------------------
router.get('/:id/preview', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, name, domain_count FROM blocklist_sources WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    const key     = `${MASTER_KEY}:${req.params.id}`;
    const domains = await redis.srandmember(key, PREVIEW_SAMPLE);

    return res.json({
      source:      rows[0].name,
      totalDomains: rows[0].domain_count,
      sample:      domains.sort(),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/blocklists/master/stats
// Master blocklist stats
// ---------------------------------------------------------------------------
router.get('/master/stats', ...adminOnly, async (req, res) => {
  try {
    const total = await redis.scard(MASTER_KEY);
    const { rows } = await query(
      `SELECT COUNT(*) FILTER (WHERE is_active) AS active_sources,
              COUNT(*) AS total_sources
       FROM blocklist_sources`
    );
    return res.json({
      totalDomains:  total,
      activeSources: parseInt(rows[0].active_sources, 10),
      totalSources:  parseInt(rows[0].total_sources, 10),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
