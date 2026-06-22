const { Router }     = require('express');
const multer         = require('multer');
const { query, withTransaction } = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { invalidatePolicy, invalidateNetworkPolicy } = require('../services/policyResolver');
const { parseCsv, classifyRows, classifyUrl, isValidUrlPattern } = require('../services/goguardianImport');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

async function setNetworkPolicy(policyId) {
  await query('UPDATE policies SET is_network_policy = false');
  await query('UPDATE policies SET is_network_policy = true WHERE id = $1', [policyId]);
}

async function bustPolicyCache(policyId) {
  const { rows } = await query(
    `SELECT DISTINCT target_id FROM policy_assignments
     WHERE policy_id = $1 AND target_type = 'student'`,
    [policyId]
  );
  await Promise.all(rows.map(r => invalidatePolicy(r.target_id)));
  await invalidateNetworkPolicy();
}

// ---------------------------------------------------------------------------
// GET /api/v1/policies/ou-list
// Returns the full OU tree synced from Google (settings.google_ous, written
// by syncOrgUnits — every OU in the account, even ones with zero users
// currently synced into our DB) plus, as a fallback for installs that have
// never run an OU sync, whatever's visible from synced users/assignments.
// (must come before /:id)
// ---------------------------------------------------------------------------
router.get('/ou-list', async (req, res) => {
  const [fromSettings, fromUsers, fromAssignments] = await Promise.all([
    query(`SELECT value FROM settings WHERE key = 'google_ous'`),
    query(`SELECT DISTINCT google_ou AS path FROM users
           WHERE google_ou IS NOT NULL AND google_ou <> ''
           ORDER BY google_ou`),
    query(`SELECT DISTINCT target_ou AS path FROM policy_assignments
           WHERE target_type = 'ou' AND target_ou IS NOT NULL
           ORDER BY target_ou`),
  ]);
  let fromTree = [];
  try {
    fromTree = (JSON.parse(fromSettings.rows[0]?.value || '[]')).map(ou => ou.path).filter(Boolean);
  } catch { /* google_ous not set or not valid JSON yet — fall back to the other two sources */ }
  const paths = [...new Set([
    ...fromTree,
    ...fromUsers.rows.map(r => r.path),
    ...fromAssignments.rows.map(r => r.path),
  ])].sort();
  res.json(paths);
});

// ---------------------------------------------------------------------------
// GET /api/v1/policies/oncampus-subnets
// Leaf IPAM subnets (no children) — used by the DNS engine to classify a
// student's current source IP as on_campus vs off_campus for location-aware
// policy assignments. Parent/organizational containers (10.0.0.0/8 etc.) are
// excluded so a public/home IP that happens to fall in a broad RFC1918 range
// never gets misclassified as on-campus.
// ---------------------------------------------------------------------------
router.get('/oncampus-subnets', async (req, res) => {
  const { rows } = await query(
    `SELECT s.subnet::text AS subnet
     FROM ipam_subnets s
     WHERE NOT EXISTS (SELECT 1 FROM ipam_subnets c WHERE c.parent_id = s.id)`
  );
  res.json(rows.map(r => r.subnet));
});

// ---------------------------------------------------------------------------
// GET /api/v1/policies/network-policy
// The single network-wide DNS floor policy (is_network_policy = true),
// fully resolved — consumed by the DNS engine for EVERY query regardless of
// identity. Falls back to the bare default-blocked-categories passthrough if
// no policy has been designated as the network policy yet.
// (must come before /:id)
// ---------------------------------------------------------------------------
router.get('/network-policy', async (req, res) => {
  const { resolveNetworkPolicy } = require('../services/policyResolver');
  const policy = await resolveNetworkPolicy();
  res.json(policy);
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
     ORDER BY subnet`
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

  const [domainRules, urlRules, blocklists, categoryRules, assignments, youtubeVideoRules] = await Promise.all([
    query('SELECT * FROM policy_domain_rules WHERE policy_id = $1 ORDER BY rule_type, domain', [req.params.id]),
    query('SELECT * FROM policy_url_rules WHERE policy_id = $1 ORDER BY rule_type, pattern', [req.params.id]),
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
    urlRules:         urlRules.rows,
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
  const allowed = ['name','description','mode','safe_search','youtube_restricted','block_page_message','youtube_categories','block_direct_ip'];
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

  if (typeof req.body.is_network_policy === 'boolean') {
    if (req.body.is_network_policy) {
      await setNetworkPolicy(req.params.id);
      policy.is_network_policy = true;
    } else {
      await query('UPDATE policies SET is_network_policy = false WHERE id = $1', [req.params.id]);
      policy.is_network_policy = false;
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
  // Domain rules are matched by exact-match or subdomain-suffix only (DNS has
  // no concept of "contains") — collapse any *.domain.com / domain.com* style
  // wildcard input to the bare domain that match actually understands, same
  // as the GoGuardian import path. A pattern that can't collapse (has a path,
  // or a wildcard in the middle) would silently never match anything if saved
  // here, so reject it and point at URL-Path Rules instead.
  const classified = classifyUrl(domain);
  if (classified.kind === 'invalid') {
    return res.status(400).json({ error: classified.reason });
  }
  if (classified.kind === 'skip' && classified.reason === 'ip-address') {
    return res.status(400).json({
      error: `"${domain}" is an IP address, not a domain — DNS filtering only matches domain names. Use the "Block direct-IP browsing" option in Safety Options instead.`,
    });
  }
  if (classified.kind !== 'domain') {
    return res.status(400).json({
      error: `"${domain}" isn't a plain domain DNS filtering can match. For a URL path or wildcard like that, add it under URL-Path Rules instead (extension-only).`,
    });
  }
  const clean = classified.value;
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
    const rawDomain = (row.domain || '').trim();
    const rule_type = (row.rule_type || row.action || '').toLowerCase();
    if (!rawDomain || !['allow','deny'].includes(rule_type)) { skipped++; continue; }
    // Same classifier as the manual single-add path and the GoGuardian
    // import — this bulk-CSV path used to insert whatever string was in the
    // "domain" column with zero validation.
    const classified = classifyUrl(rawDomain);
    if (classified.kind !== 'domain') { skipped++; continue; }
    await query(
      `INSERT INTO policy_domain_rules (policy_id, domain, rule_type, added_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (policy_id, domain) DO UPDATE SET rule_type = EXCLUDED.rule_type`,
      [req.params.id, classified.value, rule_type, req.user?.id || null]
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
// URL-path rules — extension-only (DNS can't see a path, only a domain).
// Stored ready-to-use as chrome.declarativeNetRequest urlFilter patterns.
// ---------------------------------------------------------------------------

router.get('/:id/url-rules', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM policy_url_rules WHERE policy_id = $1 ORDER BY rule_type, pattern',
    [req.params.id]
  );
  res.json(rows);
});

router.post('/:id/url-rules', async (req, res) => {
  const { pattern, rule_type } = req.body;
  if (!pattern) return res.status(400).json({ error: 'pattern required' });
  if (!['allow','deny'].includes(rule_type)) {
    return res.status(400).json({ error: 'rule_type must be allow or deny' });
  }
  const clean = pattern.trim().toLowerCase();
  // This becomes a chrome.declarativeNetRequest urlFilter pattern verbatim —
  // an invalid one doesn't just fail to match, it makes the extension's
  // updateDynamicRules() throw on every device under this policy. Reject it
  // here rather than finding out live. '*' (and DNR's '^'/'|') are allowed —
  // they're not "exceptions", they're the whole point of a pattern.
  if (!isValidUrlPattern(clean)) {
    return res.status(400).json({
      error: `"${pattern.trim()}" isn't a valid URL pattern. Use letters, numbers, and standard URL characters — "*" works as a wildcard for any part of it.`,
    });
  }
  const { rows: [rule] } = await query(
    `INSERT INTO policy_url_rules (policy_id, pattern, rule_type, added_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (policy_id, pattern) DO UPDATE SET rule_type = EXCLUDED.rule_type
     RETURNING *`,
    [req.params.id, clean, rule_type, req.user?.id || null]
  );
  await bustPolicyCache(req.params.id);
  res.status(201).json(rule);
});

router.delete('/:id/url-rules/:ruleId', async (req, res) => {
  const { rows: [rule] } = await query(
    'DELETE FROM policy_url_rules WHERE id = $1 AND policy_id = $2 RETURNING id',
    [req.params.ruleId, req.params.id]
  );
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await bustPolicyCache(req.params.id);
  res.json({ deleted: rule.id });
});

// ---------------------------------------------------------------------------
// POST /api/v1/policies/:id/import-goguardian
// Upload a GoGuardian filter-policy CSV export ("action,url,blocks...").
// Domain-only rows go to policy_domain_rules (DNS + extension); rows with a
// URL path or an un-collapsible wildcard go to policy_url_rules (extension
// only, since DNS never sees a path). preview=1 classifies without writing,
// for the frontend's review-before-import step.
// ---------------------------------------------------------------------------
router.post('/:id/import-goguardian', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let rows;
  try {
    rows = parseCsv(req.file.buffer.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { domainRules, urlRules, skipped } = classifyRows(rows);

  if (req.query.preview === '1') {
    return res.json({
      totalRows: rows.length,
      domainRules, urlRules, skipped,
    });
  }

  let domainImported = 0, urlImported = 0;
  for (const { domain, rule_type } of domainRules) {
    await query(
      `INSERT INTO policy_domain_rules (policy_id, domain, rule_type, added_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (policy_id, domain) DO UPDATE SET rule_type = EXCLUDED.rule_type`,
      [req.params.id, domain, rule_type, req.user?.id || null]
    );
    domainImported++;
  }
  for (const { pattern, rule_type } of urlRules) {
    await query(
      `INSERT INTO policy_url_rules (policy_id, pattern, rule_type, added_by, source)
       VALUES ($1,$2,$3,$4,'goguardian_import')
       ON CONFLICT (policy_id, pattern) DO UPDATE SET rule_type = EXCLUDED.rule_type`,
      [req.params.id, pattern, rule_type, req.user?.id || null]
    );
    urlImported++;
  }

  await bustPolicyCache(req.params.id);
  res.json({ domainImported, urlImported, skipped: skipped.length });
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
  const { target_type, target_id, target_ou, target_subnet, priority = 0, location = 'any' } = req.body;
  const validTypes = ['student', 'group', 'ou', 'subnet'];
  if (!validTypes.includes(target_type)) {
    return res.status(400).json({ error: `target_type must be one of: ${validTypes.join(', ')}` });
  }
  if (!['any', 'on_campus', 'off_campus'].includes(location)) {
    return res.status(400).json({ error: 'location must be one of: any, on_campus, off_campus' });
  }
  if (target_type === 'student' && !target_id) return res.status(400).json({ error: 'target_id required for student' });
  if (target_type === 'group'   && !target_id) return res.status(400).json({ error: 'target_id required for group' });
  if (target_type === 'ou'      && !target_ou) return res.status(400).json({ error: 'target_ou required for OU assignment' });
  if (target_type === 'subnet'  && !target_subnet) return res.status(400).json({ error: 'target_subnet (CIDR) required' });

  const cleanOu     = target_ou?.trim() || null;
  const cleanSubnet = target_subnet?.trim() || null;

  // student/group and ou targets each have their own per-location uniqueness
  // constraint — assigning a new policy for a target+location that already
  // has one replaces it (rather than erroring), since that's the obvious
  // intent of e.g. changing an OU's on-campus policy.
  let conflictClause = '';
  if (target_type === 'student' || target_type === 'group') {
    conflictClause = 'ON CONFLICT (target_type, target_id, location) DO UPDATE SET policy_id = EXCLUDED.policy_id, priority = EXCLUDED.priority, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()';
  } else if (target_type === 'ou') {
    conflictClause = 'ON CONFLICT (target_type, target_ou, location) DO UPDATE SET policy_id = EXCLUDED.policy_id, priority = EXCLUDED.priority, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()';
  }

  const { rows: [assignment] } = await query(
    `INSERT INTO policy_assignments
       (policy_id, target_type, target_id, target_ou, target_subnet, priority, assigned_by, location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ${conflictClause}
     RETURNING *`,
    [req.params.id, target_type, target_id || null, cleanOu, cleanSubnet, priority, req.user?.id || null, location]
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
  const { student_id, policy_id, domain: rawDomain } = req.body;
  if (!rawDomain) return res.status(400).json({ error: 'domain required' });

  const domain = rawDomain.trim().toLowerCase().replace(/\.$/, '').replace(/^https?:\/\//, '').split('/')[0];
  const trace  = [];

  const { resolvePolicy, resolveNetworkPolicy, buildResolvedPolicy, explainPolicyChain } = require('../services/policyResolver');
  // Display-only context for "why was this blocked" UIs — the precedence
  // chain (student/group/OU/default) this student resolves to, independent
  // of which policy actually decided the block below (see explainPolicyChain's
  // own `note` field for why those usually differ).
  const policyChain = student_id ? await explainPolicyChain(student_id) : null;

  let policy;
  if (policy_id) {
    // Explicit policy override — test a domain against one specific policy
    // directly, skipping student/network resolution entirely. Useful for
    // checking a policy's own rules in isolation before assigning it to
    // anyone (e.g. while still drafting it).
    const { rows: policyRows } = await query('SELECT * FROM policies WHERE id = $1', [policy_id]);
    if (!policyRows[0]) return res.status(404).json({ error: 'Policy not found' });
    policy = await buildResolvedPolicy(policyRows[0]);
    trace.push({ step: 'policy_resolved', policy_name: policy.name, mode: policy.mode || 'standard', detail: 'Manually selected — student/network resolution skipped' });
  } else if (student_id) {
    // Resolve the effective policy — must mirror dns-engine/src/resolver.js's
    // own fallback exactly (lines ~67-78): a student's OU policy only applies
    // while it's in lesson/penalty_box mode; otherwise (and always, for an
    // unidentified device — no student_id) the network-wide DNS floor policy
    // is what actually gets enforced. resolvePolicy(null) on its own returns
    // a much narrower "default passthrough" with no domain rules at all, which
    // made every "no student selected" simulation diverge from real traffic.
    const ouPolicy = await resolvePolicy(student_id);
    policy = (ouPolicy?.mode === 'lesson' || ouPolicy?.mode === 'penalty_box')
      ? ouPolicy
      : await resolveNetworkPolicy();
    trace.push({ step: 'policy_resolved', policy_name: policy?.name || '(network floor)', mode: policy?.mode || 'standard' });
  } else {
    policy = await resolveNetworkPolicy();
    trace.push({ step: 'policy_resolved', policy_name: policy?.name || '(network floor)', mode: policy?.mode || 'standard' });
  }

  // Global allowlist (admin "AI/Allowlist" overrides) — checked first, before
  // even lesson_mode/penalty_box, same precedence as resolver.js step 4.
  const { rows: globalAllowRows } = await query(`SELECT domain FROM allowlist_overrides`);
  const globalOverrideMatch = globalAllowRows.find(r => domain === r.domain || domain.endsWith(`.${r.domain}`));
  if (globalOverrideMatch) {
    trace.push({ step: 'global_allowlist', result: 'allowed', matched: globalOverrideMatch.domain });
    return res.json({ blocked: false, reason: 'global_allowlist', domain, trace, policy_chain: policyChain });
  }
  trace.push({ step: 'global_allowlist', result: 'no_match' });

  // Lesson mode
  if (policy?.mode === 'lesson') {
    const allowed = (policy.resolvedAllowDomains || []).some(e => domain === e || domain.endsWith(`.${e}`));
    if (!allowed) {
      trace.push({ step: 'lesson_mode', result: 'blocked', reason: 'Not in lesson allow-list' });
      return res.json({ blocked: true, reason: 'lesson_mode', domain, trace, policy_chain: policyChain });
    }
    trace.push({ step: 'lesson_mode', result: 'allowed', reason: 'Domain in lesson allow-list' });
    return res.json({ blocked: false, reason: 'lesson_allow', domain, trace, policy_chain: policyChain });
  }

  // Penalty box
  if (policy?.mode === 'penalty_box') {
    trace.push({ step: 'penalty_box', result: 'blocked' });
    return res.json({ blocked: true, reason: 'penalty_box', domain, trace, policy_chain: policyChain });
  }

  // Per-policy allow-list
  const globalAllow = (policy?.resolvedAllowDomains || []).some(e => domain === e || domain.endsWith(`.${e}`));
  if (globalAllow) {
    trace.push({ step: 'allow_list', result: 'allowed', matched: domain });
    return res.json({ blocked: false, reason: 'allow_list', domain, trace, policy_chain: policyChain });
  }
  trace.push({ step: 'allow_list', result: 'no_match' });

  // Explicit deny list
  const denyMatch = (policy?.resolvedDenyDomains || []).find(e => domain === e || domain.endsWith(`.${e}`));
  if (denyMatch) {
    trace.push({ step: 'deny_list', result: 'blocked', matched: denyMatch });
    return res.json({ blocked: true, reason: 'deny_list', matched: denyMatch, domain, trace, policy_chain: policyChain });
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
  if (blocklisted) return res.json({ blocked: true, reason: 'blocklist', domain, trace, policy_chain: policyChain });

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
      return res.json({ blocked: true, reason: `category:${category}`, category, domain, trace, policy_chain: policyChain });
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
  res.json({ blocked: false, reason: 'allowed', category, domain, trace, policy_chain: policyChain });
});

module.exports = router;
