const { Router } = require('express');
const { query, withTransaction } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { invalidatePolicy } = require('../services/policyResolver');

const router = Router();

router.use(authenticate, requireMinRole('admin'));

// GET /api/v1/policies
router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT p.*,
            COUNT(pa.id) FILTER (WHERE pa.id IS NOT NULL) AS assignment_count
     FROM policies p
     LEFT JOIN policy_assignments pa ON pa.policy_id = p.id
     GROUP BY p.id
     ORDER BY p.name`
  );
  res.json(rows);
});

// GET /api/v1/policies/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM policies WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });

  const [{ rows: rules }, { rows: blocklists }] = await Promise.all([
    query('SELECT * FROM policy_domain_rules WHERE policy_id = $1 ORDER BY domain', [req.params.id]),
    query(
      `SELECT pbl.source_id, bs.name, bs.url
       FROM policy_blocklists pbl
       JOIN blocklist_sources bs ON bs.id = pbl.source_id
       WHERE pbl.policy_id = $1`,
      [req.params.id]
    ),
  ]);

  res.json({ ...rows[0], domainRules: rules, blocklists });
});

// POST /api/v1/policies
router.post('/', async (req, res) => {
  const {
    name, description = null, mode = 'standard',
    safe_search_enforced = false, youtube_restricted = false,
    block_page_message = null,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await query(
    `INSERT INTO policies
       (name, description, mode, safe_search_enforced, youtube_restricted, block_page_message)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [name, description, mode, safe_search_enforced, youtube_restricted, block_page_message]
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/v1/policies/:id
router.patch('/:id', async (req, res) => {
  const allowed = ['name','description','mode','safe_search_enforced','youtube_restricted','block_page_message'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (fields.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map(f => req.body[f]);

  const { rows } = await query(
    `UPDATE policies SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });

  // Bust cache for directly-assigned students
  const { rows: affected } = await query(
    `SELECT DISTINCT target_id FROM policy_assignments
     WHERE policy_id = $1 AND target_type = 'student'`,
    [req.params.id]
  );
  await Promise.all(affected.map(r => invalidatePolicy(r.target_id)));

  res.json(rows[0]);
});

// DELETE /api/v1/policies/:id
router.delete('/:id', async (req, res) => {
  const { rows: check } = await query(
    "SELECT value FROM settings WHERE key = 'default_policy_id'"
  );
  if (check[0]?.value === req.params.id) {
    return res.status(400).json({ error: 'Cannot delete the district default policy' });
  }
  const { rows } = await query(
    'DELETE FROM policies WHERE id = $1 RETURNING id', [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
  res.json({ deleted: rows[0].id });
});

// POST /api/v1/policies/:id/clone
router.post('/:id/clone', async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows: src } = await client.query('SELECT * FROM policies WHERE id = $1', [req.params.id]);
    if (!src[0]) return null;

    const { rows: copy } = await client.query(
      `INSERT INTO policies
         (name, description, mode, safe_search_enforced, youtube_restricted, block_page_message)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        `${src[0].name} (copy)`, src[0].description, src[0].mode,
        src[0].safe_search_enforced, src[0].youtube_restricted, src[0].block_page_message,
      ]
    );
    await client.query(
      `INSERT INTO policy_domain_rules (policy_id, domain, rule_type)
       SELECT $1, domain, rule_type FROM policy_domain_rules WHERE policy_id = $2`,
      [copy[0].id, req.params.id]
    );
    await client.query(
      `INSERT INTO policy_blocklists (policy_id, source_id)
       SELECT $1, source_id FROM policy_blocklists WHERE policy_id = $2`,
      [copy[0].id, req.params.id]
    );
    return copy[0];
  });

  if (!result) return res.status(404).json({ error: 'Policy not found' });
  res.status(201).json(result);
});

// ---------------------------------------------------------------------------
// Domain rules sub-routes
// ---------------------------------------------------------------------------

router.get('/:id/rules', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM policy_domain_rules WHERE policy_id = $1 ORDER BY domain',
    [req.params.id]
  );
  res.json(rows);
});

router.post('/:id/rules', async (req, res) => {
  const { domain, rule_type } = req.body;
  if (!domain || !['allow','deny'].includes(rule_type)) {
    return res.status(400).json({ error: 'domain and rule_type (allow|deny) required' });
  }
  const { rows } = await query(
    `INSERT INTO policy_domain_rules (policy_id, domain, rule_type)
     VALUES ($1,$2,$3)
     ON CONFLICT (policy_id, domain) DO UPDATE SET rule_type = EXCLUDED.rule_type
     RETURNING *`,
    [req.params.id, domain.toLowerCase(), rule_type]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id/rules/:ruleId', async (req, res) => {
  const { rows } = await query(
    'DELETE FROM policy_domain_rules WHERE id = $1 AND policy_id = $2 RETURNING id',
    [req.params.ruleId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Rule not found' });
  res.json({ deleted: rows[0].id });
});

// ---------------------------------------------------------------------------
// Blocklist attachment sub-routes
// ---------------------------------------------------------------------------

router.post('/:id/blocklists', async (req, res) => {
  const { source_id } = req.body;
  if (!source_id) return res.status(400).json({ error: 'source_id required' });
  await query(
    'INSERT INTO policy_blocklists (policy_id, source_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.params.id, source_id]
  );
  res.status(201).json({ policy_id: req.params.id, source_id });
});

router.delete('/:id/blocklists/:sourceId', async (req, res) => {
  await query(
    'DELETE FROM policy_blocklists WHERE policy_id = $1 AND source_id = $2',
    [req.params.id, req.params.sourceId]
  );
  res.json({ ok: true });
});

module.exports = router;
