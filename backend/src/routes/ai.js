const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const classifier         = require('../services/aiClassifier');
const bookmarks          = require('../services/managedBookmarks');
const { classifyUrl }    = require('../services/goguardianImport');

const auth = [authenticate, requireMinRole('admin')];

// ---------------------------------------------------------------------------
// Domain classifications
// ---------------------------------------------------------------------------

// GET /api/v1/ai/classifications?category=&page=
router.get('/classifications', ...auth, async (req, res) => {
  const { category, page = 1, limit = 100 } = req.query;
  const conditions = [];
  const values     = [];

  if (category) {
    conditions.push(`category = $${values.length + 1}`);
    values.push(category);
  }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  try {
    const { rows } = await pool.query(
      `SELECT * FROM domain_classifications ${where}
       ORDER BY classified_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM domain_classifications ${where}`, values
    );
    res.json({ classifications: rows, total: parseInt(count, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/ai/classify  — classify one or more domains on demand
// Body: { domain: 'example.com' } OR { domains: ['a.com','b.com'] }
router.post('/classify', ...auth, async (req, res) => {
  const domains = req.body.domains
    ? req.body.domains.slice(0, 50) // cap at 50 per request
    : req.body.domain
      ? [req.body.domain]
      : [];

  if (!domains.length) return res.status(400).json({ error: 'Provide domain or domains' });

  // Single domain — return synchronously
  if (domains.length === 1) {
    try {
      const result = await classifier.classifyDomain(domains[0]);
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  // Multiple — respond immediately, run async
  res.json({ status: 'started', count: domains.length });
  classifier.batchClassify(domains).catch(err =>
    console.error('[ai] batch classify error:', err.message)
  );
});

// DELETE /api/v1/ai/classifications/:domain — remove cached classification
router.delete('/classifications/:domain', ...auth, async (req, res) => {
  await pool.query('DELETE FROM domain_classifications WHERE domain = $1', [req.params.domain]);
  res.json({ deleted: true });
});

// GET /api/v1/ai/stats  — classification summary counts by category
router.get('/stats', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         category,
         COUNT(*)                                          AS total,
         COUNT(*) FILTER (WHERE is_educational)           AS educational,
         COUNT(*) FILTER (WHERE is_time_wasting)          AS time_wasting,
         COUNT(*) FILTER (WHERE is_productive)            AS productive,
         AVG(confidence)::NUMERIC(4,3)                    AS avg_confidence
       FROM domain_classifications
       GROUP BY category
       ORDER BY total DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Global allowlist overrides
// ---------------------------------------------------------------------------

// GET /api/v1/ai/allowlist?source=
router.get('/allowlist', ...auth, async (req, res) => {
  const { source } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT a.*, u.full_name AS added_by_name
       FROM allowlist_overrides a
       LEFT JOIN users u ON u.id = a.added_by
       ${source ? 'WHERE a.source = $1' : ''}
       ORDER BY a.added_at DESC`,
      source ? [source] : []
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/ai/allowlist  — add a manual override
router.post('/allowlist', ...auth, async (req, res) => {
  const { domain, notes } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const stripped = domain.toLowerCase().replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0];
  // Same collapse as policy domain rules — matching is exact/subdomain-suffix
  // only, so a *.domain.com or domain.com* wildcard needs to collapse to the
  // bare domain or it will silently never match anything.
  const classified = classifyUrl(stripped);
  if (classified.kind !== 'domain') {
    return res.status(400).json({ error: `"${domain}" isn't a plain domain this allowlist can match.` });
  }
  const clean = classified.value;

  try {
    const { rows } = await pool.query(
      `INSERT INTO allowlist_overrides (domain, source, notes, added_by)
       VALUES ($1, 'manual', $2, $3)
       ON CONFLICT (domain) DO UPDATE SET notes = EXCLUDED.notes, added_at = NOW()
       RETURNING *`,
      [clean, notes || null, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/ai/allowlist/:domain
router.delete('/allowlist/:domain', ...auth, async (req, res) => {
  await pool.query('DELETE FROM allowlist_overrides WHERE domain = $1', [req.params.domain]);
  res.json({ deleted: true });
});

// POST /api/v1/ai/sync-bookmarks  — pull managed bookmarks from Google Admin
router.post('/sync-bookmarks', ...auth, async (req, res) => {
  try {
    const result = await bookmarks.syncManagedBookmarks(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
