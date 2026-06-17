const { Router }     = require('express');
const { query, withTransaction } = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { invalidatePolicy } = require('../services/policyResolver');

const router = Router();
router.use(authenticate, requireMinRole('admin'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getDefaultPolicyId() {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'default_policy_id'");
  return rows[0]?.value || null;
}

async function setDefaultPolicy(policyId) {
  await query(
    `INSERT INTO settings (key, value) VALUES ('default_policy_id', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [policyId]
  );
  await query('UPDATE policies SET is_default = false');
  await query('UPDATE policies SET is_default = true WHERE id = $1', [policyId]);
}

async function bustPolicyCache(policyId) {
  const { rows } = await query(
    `SELECT DISTINCT target_id FROM policy_assignments
     WHERE policy_id = $1 AND target_type = 'student'`,
    [policyId]
  );
  await Promise.all(rows.map(r => invalidatePolicy(r.target_id)));
}

// ---------------------------------------------------------------------------
// GET /api/v1/policies/ou-list
// Returns distinct OUs from synced users + OUs that already have assignments
// (must come before /:id)
// ---------------------------------------------------------------------------
router.get('/ou-list', async (req, res) => {
  const [fromUsers, fromAssignments] = await Promise.all([
    query(`SELECT DISTINCT google_ou AS path FROM users
           WHERE google_ou IS NOT NULL AND google_ou <> ''
           ORDER BY google_ou`),
    query(`SELECT DISTINCT target_ou AS path FROM policy_assignments
           WHERE target_type = 'ou' AND target_ou IS NOT NULL
           ORDER BY target_ou`),
  ]);
  const paths = [...new Set([
    ...fromUsers.rows.map(r => r.path),
    ...fromAssignments.rows.map(r => r.path),
  ])].sort();
  res.json(paths);
});

// ---------------------------------------------------------------------------
// GET /api/v1/policies/subnet-assignments
// Full resolved policy per subnet — consumed by the DNS engine
// (must come before /:id)
// ---------------------------------------------------------------------------
router.get('/subnet-assignments', async (req, res) => {
  const { resolvePolicy } = require('../services/policyResolver');
  const { rows } = await query(
    `SELECT DISTINCT pa.target_subnet::text AS subnet, pa.policy_id
     FROM policy_assignments pa
     WHERE pa.target_type = 'subnet' AND pa.target_subnet IS NOT NULL
     ORDER BY pa.target_subnet`
  );
  const results = [];
  for (const row of rows) {
    const resolved = await resolvePolicy(null).catch(() => null);
    // Resolve policy directly by ID for subnet (bypass student-chain)
    const { rows: [pol] } = await query('SELECT * FROM policies WHERE id = $1', [row.policy_id]);
    if (!pol) continue;
    // Build a minimal resolved structure matching policyResolver output
    const [domainRows, catRows, blRows, defaultBlockRows] = await Promise.all([
      query('SELECT domain, rule_type FROM policy_domain_rules WHERE policy_id = $1', [row.policy_id]),
      query(`SELECT wc.slug, pcr.action FROM policy_category_rules pcr
             JOIN website_categories wc ON wc.id = pcr.category_id
             WHERE pcr.policy_id = $1`, [row.policy_id]),
      query('SELECT source_id FROM policy_blocklists WHERE policy_id = $1', [row.policy_id]),
      query('SELECT slug FROM website_categories WHERE is_blocked_default = true'),
    ]);
    const allowRules  = domainRows.rows.filter(r => r.rule_type === 'allow').map(r => r.domain);
    const denyRules   = domainRows.rows.filter(r => r.rule_type === 'deny').map(r => r.domain);
    const polBlocked  = catRows.rows.filter(r => r.action === 'block').map(r => r.slug);
    const polAllowed  = catRows.rows.filter(r => r.action === 'allow').map(r => r.slug);
    const defBlocked  = defaultBlockRows.rows.map(r => r.slug);
    const blockedCats = [...new Set([...defBlocked, ...polBlocked])].filter(s => !polAllowed.includes(s));
    results.push({
      subnet: row.subnet,
      policy: {
        ...pol,
        mode:                pol.mode || 'standard',
        resolvedAllowDomains: allowRules,
        resolvedDenyDomains:  denyRules,
        activeBloclistIds:    blRows.rows.map(r => r.source_id),
        blockedCategories:    blockedCats,
        allowedCategories:    polAllowed,
      },
    });
  }
  res.json(results);
});

// ---------------------------------------------------------------------------
// GET /api/v1/policies
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT p.*,
           COUNT(DISTINCT pa.id)::int  AS assignment_count,
           COUNT(DISTINCT pdr.id)::int AS rule_count
    FROM policies p
    LEFT JOIN policy_assignments   pa  ON pa.policy_id  = p.id
    LEFT JOIN policy_domain_rules  pdr ON pdr.policy_id = p.id
    GROUP BY p.id
    ORDER BY p.is_default DESC, p.name
  `);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// GET /api/v1/policies/:id  (full policy with all sub-resources)
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  const { rows: [policy] } = await query('SELECT * FROM policies WHERE id = $1', [req.params.id]);
  if (!policy) return res.status(404).json({ error: 'Policy not found' });

  const [domainRules, blocklists, categoryRules, assignments, youtubeVideoRules] = await Promise.all([
    query('SELECT * FROM policy_domain_rules WHERE policy_id = $1 ORDER BY rule_type, domain', [req.params.id]),
    query(
      `SELECT pbl.source_id, bs.name, bs.url, bs.domain_count
       FROM policy_blocklists pbl
       JOIN blocklist_sources bs ON bs.id = pbl.source_id
       WHERE pbl.policy_id = $1`,
      [req.params.id]
    ),
    query(
      `SELECT pcr.id, pcr.action, wc.slug, wc.name AS category_name, wc.risk_level, wc.is_blocked_default
       FROM policy_category_rules pcr
       JOIN website_categories wc ON wc.id = pcr.category_id
       WHERE pcr.policy_id = $1
       ORDER BY wc.sort_order`,
      [req.params.id]
    ),
    query(
      `SELECT pa.*,
              pa.target_subnet::text AS target_subnet_str,
              CASE pa.target_type
                WHEN 'student' THEN u.full_name
                WHEN 'group'   THEN g.name
                WHEN 'ou'      THEN pa.target_ou
                WHEN 'subnet'  THEN pa.target_subnet::text
                ELSE pa.target_ou
              END AS target_name
       FROM policy_assignments pa
       LEFT JOIN users  u ON pa.target_type = 'student' AND u.id = pa.target_id
       LEFT JOIN groups g ON pa.target_type = 'group'   AND g.id = pa.target_id
       WHERE pa.policy_id = $1
       ORDER BY pa.target_type, target_name`,
      [req.params.id]
    ),
    query(
      `SELECT * FROM youtube_video_rules WHERE policy_id = $1 ORDER BY added_at DESC`,
      [req.params.id]
    ),
  ]);

  res.json({
    ...policy,
    domainRules:      domainRules.rows,
    blocklists:       blocklists.rows,
    categoryRules:    categoryRules.rows,
    assignments:      assignments.rows,
    youtubeVideoRules: youtubeVideoRules.rows,
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/policies  — create
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const {
    name,
    description       = null,
    mode              = 'standard',
    safe_search       = true,
    youtube_restricted = 'moderate',
    block_page_message = null,
    is_default        = false,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows: [policy] } = await query(
    `INSERT INTO policies
       (name, description, mode, safe_search, youtube_restricted, block_page_message, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, description, mode, safe_search, youtube_restricted, block_page_message, req.user?.id || null]
  );

  if (is_default) await setDefaultPolicy(policy.id);

  res.status(201).json({ ...policy, is_default: !!is_default });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/policies/:id  — update settings
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  const allowed = ['name','description','mode','safe_search','youtube_restricted','block_page_message','youtube_categories'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));

  let policy;
  if (fields.length > 0) {
    const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values = fields.map(f => req.body[f]);
    const { rows } = await query(
      `UPDATE policies SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
    policy = rows[0];
  } else {
    const { rows } = await query('SELECT * FROM policies WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
    policy = rows[0];
  }

  if (typeof req.body.is_default === 'boolean') {
    if (req.body.is_default) {
      await setDefaultPolicy(req.params.id);
      policy.is_default = true;
    } else {
      const defaultId = await getDefaultPolicyId();
      if (defaultId === req.params.id) {
        await query("DELETE FROM settings WHERE key = 'default_policy_id'");
        await query('UPDATE policies SET is_default = false WHERE id = $1', [req.params.id]);
        policy.is_default = false;
      }
    }
  }

  await bustPolicyCache(req.params.id);
  res.json(policy);
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/policies/:id
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const defaultId = await getDefaultPolicyId();
  if (defaultId === req.params.id) {
    return res.status(400).json({ error: 'Cannot delete the district default policy' });
  }
  const { rows } = await query('DELETE FROM policies WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
  res.json({ deleted: rows[0].id });
});

// ---------------------------------------------------------------------------
// POST /api/v1/policies/:id/clone
// ---------------------------------------------------------------------------
router.post('/:id/clone', async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows: [src] } = await client.query('SELECT * FROM policies WHERE id = $1', [req.params.id]);
    if (!src) return null;

    const { rows: [copy] } = await client.query(
      `INSERT INTO policies
         (name, description, mode, safe_search, youtube_restricted, block_page_message, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        `${src.name} (copy)`, src.description, src.mode,
        src.safe_search, src.youtube_restricted, src.block_page_message,
        req.user?.id || null,
      ]
    );
    await client.query(
      `INSERT INTO policy_domain_rules (policy_id, domain, rule_type)
       SELECT $1, domain, rule_type FROM policy_domain_rules WHERE policy_id = $2`,
      [copy.id, req.params.id]
    );
    await client.query(
      `INSERT INTO policy_blocklists (policy_id, source_id)
       SELECT $1, source_id FROM policy_blocklists WHERE policy_id = $2`,
      [copy.id, req.params.id]
    );
    await client.query(
      `INSERT INTO policy_category_rules (policy_id, category_id, action)
       SELECT $1, category_id, action FROM policy_category_rules WHERE policy_id = $2`,
      [copy.id, req.params.id]
    );
    return copy;
  });

  if (!result) return res.status(404).json({ error: 'Policy not found' });
  res.status(201).json(result);
});

// ---------------------------------------------------------------------------
// Domain rules
// ---------------------------------------------------------------------------

router.get('/:id/rules', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM policy_domain_rules WHERE policy_id = $1 ORDER BY rule_type, domain',
    [req.params.id]
  );
  res.json(rows);
});

router.post('/:id/rules', async (req, res) => {
  const { domain, rule_type } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!['allow','deny'].includes(rule_type)) {
    return res.status(400).json({ error: 'rule_type must be allow or deny' });
  }
  const clean = domain.trim().toLowerCase().replace(/\.$/, '');
  const { rows: [rule] } = await query(
    `INSERT INTO policy_domain_rules (policy_id, domain, rule_type, added_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (policy_id, domain) DO UPDATE SET rule_type = EXCLUDED.rule_type
     RETURNING *`,
    [req.params.id, clean, rule_type, req.user?.id || null]
  );
  await bustPolicyCache(req.params.id);
  res.status(201).json(rule);
});

router.delete('/:id/rules/:ruleId', async (req, res) => {
  const { rows: [rule] } = await query(
    'DELETE FROM policy_domain_rules WHERE id = $1 AND policy_id = $2 RETURNING id',
    [req.params.ruleId, req.params.id]
  );
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await bustPolicyCache(req.params.id);
  res.json({ deleted: rule.id });
});

// POST /api/v1/policies/:id/rules/import  — body: [{domain, rule_type}, ...]
router.post('/:id/rules/import', async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : req.body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Provide an array of {domain, rule_type} objects' });
  }

  let imported = 0, skipped = 0;
  for (const row of rows) {
    const domain    = (row.domain || '').trim().toLowerCase().replace(/\.$/, '');
    const rule_type = (row.rule_type || row.action || '').toLowerCase();
    if (!domain || !['allow','deny'].includes(rule_type)) { skipped++; continue; }
    await query(
      `INSERT INTO policy_domain_rules (policy_id, domain, rule_type, added_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (policy_id, domain) DO UPDATE SET rule_type = EXCLUDED.rule_type`,
      [req.params.id, domain, rule_type, req.user?.id || null]
    ).catch(() => { skipped++; return null; });
    imported++;
  }
  await bustPolicyCache(req.params.id);
  res.json({ imported, skipped });
});

// GET /api/v1/policies/:id/rules/export  — returns CSV
router.get('/:id/rules/export', async (req, res) => {
  const { rows: [policy] } = await query('SELECT name FROM policies WHERE id = $1', [req.params.id]);
  if (!policy) return res.status(404).json({ error: 'Policy not found' });

  const { rows } = await query(
    'SELECT domain, rule_type FROM policy_domain_rules WHERE policy_id = $1 ORDER BY rule_type, domain',
    [req.params.id]
  );

  const csv = ['domain,rule_type', ...rows.map(r => `${r.domain},${r.rule_type}`)].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${policy.name.replace(/[^a-z0-9]/gi,'_')}_rules.csv"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// Blocklist attachment
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

// ---------------------------------------------------------------------------
// YouTube video rules
// ---------------------------------------------------------------------------

// POST /api/v1/policies/:id/youtube-videos
router.post('/:id/youtube-videos', async (req, res) => {
  const { video_id, action, title, channel_title, thumbnail_url, category_id, category_name } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  if (!['allow', 'block'].includes(action)) return res.status(400).json({ error: 'action must be allow or block' });

  const clean = video_id.trim();
  const { rows: [rule] } = await query(
    `INSERT INTO youtube_video_rules
       (policy_id, video_id, action, title, channel_title, thumbnail_url, category_id, category_name, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (policy_id, video_id) DO UPDATE
       SET action=EXCLUDED.action, title=EXCLUDED.title, channel_title=EXCLUDED.channel_title,
           thumbnail_url=EXCLUDED.thumbnail_url, category_id=EXCLUDED.category_id,
           category_name=EXCLUDED.category_name
     RETURNING *`,
    [req.params.id, clean, action, title||null, channel_title||null, thumbnail_url||null,
     category_id||null, category_name||null, req.user?.id||null]
  );
  await bustPolicyCache(req.params.id);
  res.status(201).json(rule);
});

// DELETE /api/v1/policies/:id/youtube-videos/:videoId
router.delete('/:id/youtube-videos/:videoId', async (req, res) => {
  const { rows: [rule] } = await query(
    'DELETE FROM youtube_video_rules WHERE policy_id=$1 AND video_id=$2 RETURNING *',
    [req.params.id, req.params.videoId]
  );
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await bustPolicyCache(req.params.id);
  res.json({ deleted: rule });
});

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

router.post('/:id/assignments', async (req, res) => {
  const { target_type, target_id, target_ou, target_subnet, priority = 0 } = req.body;
  const validTypes = ['student', 'group', 'ou', 'subnet'];
  if (!validTypes.includes(target_type)) {
    return res.status(400).json({ error: `target_type must be one of: ${validTypes.join(', ')}` });
  }
  if (target_type === 'student' && !target_id) return res.status(400).json({ error: 'target_id required for student' });
  if (target_type === 'group'   && !target_id) return res.status(400).json({ error: 'target_id required for group' });
  if (target_type === 'ou'      && !target_ou) return res.status(400).json({ error: 'target_ou required for OU assignment' });
  if (target_type === 'subnet'  && !target_subnet) return res.status(400).json({ error: 'target_subnet (CIDR) required' });

  const cleanOu     = target_ou?.trim() || null;
  const cleanSubnet = target_subnet?.trim() || null;

  const { rows: [assignment] } = await query(
    `INSERT INTO policy_assignments
       (policy_id, target_type, target_id, target_ou, target_subnet, priority, assigned_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.id, target_type, target_id || null, cleanOu, cleanSubnet, priority, req.user?.id || null]
  );
  await bustPolicyCache(req.params.id);
  res.status(201).json(assignment);
});

router.delete('/:id/assignments/:assignmentId', async (req, res) => {
  const { rows: [assignment] } = await query(
    'DELETE FROM policy_assignments WHERE id = $1 AND policy_id = $2 RETURNING *',
    [req.params.assignmentId, req.params.id]
  );
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  await bustPolicyCache(req.params.id);
  res.json({ deleted: assignment });
});

// ---------------------------------------------------------------------------
// POST /api/v1/policies/simulate  — filter simulator
// (must come before /:id to avoid route collision)
// ---------------------------------------------------------------------------
router.post('/simulate', async (req, res) => {
  const { student_id, domain: rawDomain } = req.body;
  if (!rawDomain) return res.status(400).json({ error: 'domain required' });

  const domain = rawDomain.trim().toLowerCase().replace(/\.$/, '').replace(/^https?:\/\//, '').split('/')[0];
  const trace  = [];

  // Resolve the student's effective policy
  const { resolvePolicy } = require('../services/policyResolver');
  const policy = await resolvePolicy(student_id || null);
  trace.push({ step: 'policy_resolved', policy_name: policy?.name || '(default passthrough)', mode: policy?.mode || 'standard' });

  // Lesson mode
  if (policy?.mode === 'lesson') {
    const allowed = (policy.resolvedAllowDomains || []).some(e => domain === e || domain.endsWith(`.${e}`));
    if (!allowed) {
      trace.push({ step: 'lesson_mode', result: 'blocked', reason: 'Not in lesson allow-list' });
      return res.json({ blocked: true, reason: 'lesson_mode', domain, trace });
    }
    trace.push({ step: 'lesson_mode', result: 'allowed', reason: 'Domain in lesson allow-list' });
    return res.json({ blocked: false, reason: 'lesson_allow', domain, trace });
  }

  // Penalty box
  if (policy?.mode === 'penalty_box') {
    trace.push({ step: 'penalty_box', result: 'blocked' });
    return res.json({ blocked: true, reason: 'penalty_box', domain, trace });
  }

  // Global allow-list
  const globalAllow = (policy?.resolvedAllowDomains || []).some(e => domain === e || domain.endsWith(`.${e}`));
  if (globalAllow) {
    trace.push({ step: 'allow_list', result: 'allowed', matched: domain });
    return res.json({ blocked: false, reason: 'allow_list', domain, trace });
  }
  trace.push({ step: 'allow_list', result: 'no_match' });

  // Explicit deny list
  const denyMatch = (policy?.resolvedDenyDomains || []).find(e => domain === e || domain.endsWith(`.${e}`));
  if (denyMatch) {
    trace.push({ step: 'deny_list', result: 'blocked', matched: denyMatch });
    return res.json({ blocked: true, reason: 'deny_list', matched: denyMatch, domain, trace });
  }
  trace.push({ step: 'deny_list', result: 'no_match' });

  // Blocklist check
  const redis = require('../redis');
  const parts  = domain.split('.');
  const checks = [];
  for (let i = 0; i < parts.length - 1; i++) checks.push(parts.slice(i).join('.'));
  let blocklisted = false;
  for (const check of checks) {
    const inList = await redis.sismember('classguard:blocklist:domains', check).catch(() => 0);
    if (inList) { blocklisted = true; trace.push({ step: 'blocklist', result: 'blocked', matched: check }); break; }
  }
  if (!blocklisted) trace.push({ step: 'blocklist', result: 'no_match' });
  if (blocklisted) return res.json({ blocked: true, reason: 'blocklist', domain, trace });

  // Category check
  const CATEGORY_KEY = 'classguard:domain:category';
  const catPipeline  = redis.pipeline();
  for (const c of checks) catPipeline.hget(CATEGORY_KEY, c);
  const catResults = await catPipeline.exec().catch(() => []);
  const catHit     = catResults.find(([e, v]) => !e && v);
  const category   = catHit?.[1] || null;

  if (category) {
    const blockedCats = policy?.blockedCategories || [];
    const allowedCats = policy?.allowedCategories || [];
    if (blockedCats.includes(category)) {
      trace.push({ step: 'category', result: 'blocked', category });
      return res.json({ blocked: true, reason: `category:${category}`, category, domain, trace });
    }
    if (allowedCats.includes(category)) {
      trace.push({ step: 'category', result: 'allowed', category });
    } else {
      trace.push({ step: 'category', result: 'not_blocked', category });
    }
  } else {
    trace.push({ step: 'category', result: 'uncategorized' });
  }

  trace.push({ step: 'upstream', result: 'allowed' });
  res.json({ blocked: false, reason: 'allowed', category, domain, trace });
});

module.exports = router;
