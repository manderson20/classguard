const redis      = require('../redis');
const { query }  = require('../db');

const POLICY_TTL = 60; // seconds

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function policyKey(studentId, location) {
  return `student:policy:${studentId}:${location}`;
}

const LOCATIONS = ['any', 'on_campus', 'off_campus'];

async function invalidatePolicy(studentId) {
  await redis.del(...LOCATIONS.map(l => policyKey(studentId, l)));
}

async function invalidatePoliciesForClass(classId) {
  const { rows } = await query(
    'SELECT student_id FROM class_members WHERE class_id = $1',
    [classId]
  );
  if (rows.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const { student_id } of rows) {
    for (const l of LOCATIONS) pipeline.del(policyKey(student_id, l));
  }
  await pipeline.exec();
  return rows.map(r => r.student_id);
}

// ---------------------------------------------------------------------------
// Core resolver — full precedence chain
// location: 'on_campus' | 'off_campus' | 'any' (default) — determined by the
// caller from the student's current source IP. A location-specific
// assignment at a given precedence level (student/group/OU) wins over an
// 'any' assignment at that same level; 'any' is the fallback when no
// location-specific assignment exists for that target.
// ---------------------------------------------------------------------------

async function resolvePolicy(studentId, location = 'any') {
  if (!LOCATIONS.includes(location)) location = 'any';
  if (!studentId) return await defaultPassthrough();

  // --- Cache hit ---
  const cached = await redis.get(policyKey(studentId, location));
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  let policy = null;
  let mode   = null;
  let resolvedAllowDomains = [];
  let resolvedDenyDomains  = [];

  // 1. Active lesson session (teacher override — highest priority)
  const { rows: lessonRows } = await query(
    `SELECT ls.id, ls.allowed_domains, ls.teacher_id
     FROM lesson_sessions ls
     JOIN class_members cm ON cm.class_id = ls.class_id
     WHERE cm.student_id = $1
       AND ls.is_active = true
     ORDER BY ls.started_at DESC
     LIMIT 1`,
    [studentId]
  );

  if (lessonRows[0]) {
    mode = 'lesson';
    resolvedAllowDomains = lessonRows[0].allowed_domains || [];
  }

  // 2. Active penalty box
  if (!mode) {
    const { rows: pbRows } = await query(
      `SELECT id FROM penalty_box
       WHERE student_id = $1
         AND released_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [studentId]
    );
    if (pbRows[0]) mode = 'penalty_box';
  }

  // 3. Student-level policy assignment — a location-specific assignment
  // beats an 'any' assignment for the same student.
  const { rows: studentRows } = await query(
    `SELECT p.* FROM policies p
     JOIN policy_assignments pa ON pa.policy_id = p.id
     WHERE pa.target_type = 'student'
       AND pa.target_id   = $1
       AND pa.location IN ($2, 'any')
     ORDER BY (pa.location = $2) DESC, pa.priority DESC
     LIMIT 1`,
    [studentId, location]
  );
  if (studentRows[0]) policy = studentRows[0];

  // 4. Group-level policy (highest-priority group wins; location-specific
  // beats 'any' within the same group)
  if (!policy) {
    const { rows: groupRows } = await query(
      `SELECT p.*, pa.priority FROM policies p
       JOIN policy_assignments pa ON pa.policy_id = p.id
       JOIN group_members gm     ON gm.group_id   = pa.target_id
       WHERE pa.target_type = 'group'
         AND gm.user_id     = $1
         AND pa.location IN ($2, 'any')
       ORDER BY (pa.location = $2) DESC, pa.priority DESC
       LIMIT 1`,
      [studentId, location]
    );
    if (groupRows[0]) policy = groupRows[0];
  }

  // 5. OU-level policy (most-specific OU prefix wins first; among
  // assignments at that same OU, location-specific beats 'any')
  if (!policy) {
    const { rows: userRows } = await query(
      'SELECT google_ou FROM users WHERE id = $1',
      [studentId]
    );
    const ou = userRows[0]?.google_ou;
    if (ou) {
      const { rows: ouRows } = await query(
        `SELECT p.* FROM policies p
         JOIN policy_assignments pa ON pa.policy_id = p.id
         WHERE pa.target_type = 'ou'
           AND $1 LIKE pa.target_ou || '%'
           AND pa.location IN ($2, 'any')
         ORDER BY LENGTH(pa.target_ou) DESC, (pa.location = $2) DESC
         LIMIT 1`,
        [ou, location]
      );
      if (ouRows[0]) policy = ouRows[0];
    }
  }

  // 6. District-wide default policy
  if (!policy) {
    const { rows: settingRows } = await query(
      "SELECT value FROM settings WHERE key = 'default_policy_id'"
    );
    if (settingRows[0]?.value) {
      const { rows: defRows } = await query(
        'SELECT * FROM policies WHERE id = $1',
        [settingRows[0].value]
      );
      if (defRows[0]) policy = defRows[0];
    }
  }

  const result = await buildResolvedPolicy(policy, mode, resolvedAllowDomains, resolvedDenyDomains);

  // Cache the resolved policy
  await redis.set(policyKey(studentId, location), JSON.stringify(result), 'EX', POLICY_TTL);

  return result;
}

// ---------------------------------------------------------------------------
// Shared resolution builder — turns a base `policies` row into the full
// resolved shape (domain rules, blocklists, category rules merged with the
// district-wide always-blocked defaults). Used by both the per-student OU
// chain above and the network-wide DNS floor below.
// ---------------------------------------------------------------------------
async function buildResolvedPolicy(policy, mode = null, baseAllowDomains = [], baseDenyDomains = []) {
  let resolvedAllowDomains = [...baseAllowDomains];
  let resolvedDenyDomains  = [...baseDenyDomains];

  if (policy) {
    const { rows: ruleRows } = await query(
      'SELECT domain, rule_type FROM policy_domain_rules WHERE policy_id = $1',
      [policy.id]
    );
    resolvedAllowDomains = [
      ...resolvedAllowDomains,
      ...ruleRows.filter(r => r.rule_type === 'allow').map(r => r.domain),
    ];
    resolvedDenyDomains = [
      ...resolvedDenyDomains,
      ...ruleRows.filter(r => r.rule_type === 'deny').map(r => r.domain),
    ];
  }

  // --- Active blocklist IDs for this policy ---
  let activeBloclistIds = [];
  if (policy) {
    const { rows: blRows } = await query(
      'SELECT source_id FROM policy_blocklists WHERE policy_id = $1',
      [policy.id]
    );
    activeBloclistIds = blRows.map(r => r.source_id);
  }

  // --- Category rules: default blocks + per-policy overrides ---
  // Categories with is_blocked_default=true are always blocked for all students;
  // a policy can add extra category blocks or lift a default block with an 'allow' rule.
  const { rows: defaultBlockRows } = await query(
    `SELECT slug FROM website_categories WHERE is_blocked_default = true`
  );
  const defaultBlockedSlugs = defaultBlockRows.map(r => r.slug);

  let policyBlockedCategories = [];
  let allowedCategories = [];
  if (policy) {
    const { rows: catRows } = await query(
      `SELECT wc.slug, pcr.action
       FROM policy_category_rules pcr
       JOIN website_categories wc ON wc.id = pcr.category_id
       WHERE pcr.policy_id = $1`,
      [policy.id]
    );
    policyBlockedCategories = catRows.filter(r => r.action === 'block').map(r => r.slug);
    allowedCategories       = catRows.filter(r => r.action === 'allow').map(r => r.slug);
  }

  // Merge and subtract explicit allows (policy can lift a default block if needed)
  const blockedCategories = [
    ...new Set([...defaultBlockedSlugs, ...policyBlockedCategories]),
  ].filter(s => !allowedCategories.includes(s));

  // URL-path rules — extension-only, DNS never sees a path so it ignores this.
  let resolvedUrlRules = [];
  if (policy) {
    const { rows } = await query(
      'SELECT pattern, rule_type FROM policy_url_rules WHERE policy_id = $1',
      [policy.id]
    );
    resolvedUrlRules = rows;
  }

  return {
    ...(policy || {}),
    mode:                mode || policy?.mode || 'standard',
    resolvedAllowDomains,
    resolvedDenyDomains,
    resolvedUrlRules,
    activeBloclistIds,
    blockedCategories,
    allowedCategories,
  };
}

// Cached so unidentified-device DNS lookups don't hit Postgres on every query
const DEFAULT_PASSTHROUGH_KEY = 'classguard:policy:default-passthrough';
const DEFAULT_PASSTHROUGH_TTL = 300; // 5 minutes

async function defaultPassthrough() {
  const cached = await redis.get(DEFAULT_PASSTHROUGH_KEY).catch(() => null);
  if (cached) { try { return JSON.parse(cached); } catch {} }

  const result = await buildResolvedPolicy(null);
  await redis.set(DEFAULT_PASSTHROUGH_KEY, JSON.stringify(result), 'EX', DEFAULT_PASSTHROUGH_TTL)
    .catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// Explain the precedence chain for a student — same tiers resolvePolicy()
// walks (lesson > penalty_box > student > group > OU > district default),
// but returns every candidate it checked instead of short-circuiting at the
// first match. Display-only (the "why was this blocked" UI); never called
// from the hot DNS-query path, so it's fine that this duplicates
// resolvePolicy()'s queries rather than refactoring that latency-sensitive
// function to collect a trace it doesn't otherwise need.
// ---------------------------------------------------------------------------
async function explainPolicyChain(studentId, location = 'any') {
  if (!LOCATIONS.includes(location)) location = 'any';
  if (!studentId) return null;

  const { rows: lessonRows } = await query(
    `SELECT ls.id FROM lesson_sessions ls
     JOIN class_members cm ON cm.class_id = ls.class_id
     WHERE cm.student_id = $1 AND ls.is_active = true
     ORDER BY ls.started_at DESC LIMIT 1`,
    [studentId]
  );
  const { rows: pbRows } = await query(
    `SELECT id FROM penalty_box
     WHERE student_id = $1 AND released_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [studentId]
  );
  const { rows: studentRows } = await query(
    `SELECT p.id, p.name FROM policies p
     JOIN policy_assignments pa ON pa.policy_id = p.id
     WHERE pa.target_type = 'student' AND pa.target_id = $1 AND pa.location IN ($2, 'any')
     ORDER BY (pa.location = $2) DESC, pa.priority DESC LIMIT 1`,
    [studentId, location]
  );
  const { rows: groupRows } = await query(
    `SELECT p.id, p.name, g.name AS group_name FROM policies p
     JOIN policy_assignments pa ON pa.policy_id = p.id
     JOIN group_members gm     ON gm.group_id   = pa.target_id
     JOIN groups g             ON g.id          = pa.target_id
     WHERE pa.target_type = 'group' AND gm.user_id = $1 AND pa.location IN ($2, 'any')
     ORDER BY (pa.location = $2) DESC, pa.priority DESC LIMIT 1`,
    [studentId, location]
  );
  const { rows: userRows } = await query('SELECT google_ou FROM users WHERE id = $1', [studentId]);
  const ou = userRows[0]?.google_ou || null;
  let ouRow = null;
  if (ou) {
    const { rows: ouRows } = await query(
      `SELECT p.id, p.name, pa.target_ou FROM policies p
       JOIN policy_assignments pa ON pa.policy_id = p.id
       WHERE pa.target_type = 'ou' AND $1 LIKE pa.target_ou || '%' AND pa.location IN ($2, 'any')
       ORDER BY LENGTH(pa.target_ou) DESC, (pa.location = $2) DESC LIMIT 1`,
      [ou, location]
    );
    ouRow = ouRows[0] || null;
  }
  const { rows: settingRows } = await query("SELECT value FROM settings WHERE key = 'default_policy_id'");
  let defaultRow = null;
  if (settingRows[0]?.value) {
    const { rows: defRows } = await query('SELECT id, name FROM policies WHERE id = $1', [settingRows[0].value]);
    defaultRow = defRows[0] || null;
  }

  const lessonActive = !!lessonRows[0];
  const penaltyActive = !lessonActive && !!pbRows[0];
  const studentTier = studentRows[0] || null;
  const groupTier   = !studentTier ? (groupRows[0] || null) : null;
  const ouTier       = !studentTier && !groupTier ? ouRow : null;
  const defaultTier  = !studentTier && !groupTier && !ouTier ? defaultRow : null;

  const resolvedTier =
    lessonActive ? 'lesson' :
    penaltyActive ? 'penalty_box' :
    studentTier ? 'student' :
    groupTier ? 'group' :
    ouTier ? 'ou' :
    defaultTier ? 'default' : 'none';

  return {
    resolved_tier: resolvedTier,
    tiers: [
      { tier: 'lesson',      label: 'Active lesson session',  active: lessonActive },
      { tier: 'penalty_box', label: 'Active penalty box',     active: penaltyActive },
      { tier: 'student',     label: 'Student-assigned policy', policy: studentTier },
      { tier: 'group',       label: groupRows[0]?.group_name ? `Group policy (${groupRows[0].group_name})` : 'Group policy', policy: groupRows[0] || null },
      { tier: 'ou',          label: ou ? `OU policy (${ou})` : 'OU policy', policy: ouRow },
      { tier: 'default',     label: 'District default policy', policy: defaultRow },
    ],
    note: (resolvedTier === 'lesson' || resolvedTier === 'penalty_box')
      ? null
      : 'This precedence chain only controls DNS-level blocking while a lesson or penalty box is active. ' +
        'Otherwise the network-wide DNS floor (shown in the trace above) decides DNS blocks for everyone; ' +
        (resolvedTier === 'none'
          ? "this student has no assigned policy at any tier (no student/group/OU/default match)."
          : `the student's own resolved policy (the "${resolvedTier}" tier above) is enforced separately by the Chrome extension, not DNS.`),
  };
}

// ---------------------------------------------------------------------------
// Network-wide DNS floor — a single policy enforced for EVERY DNS query
// regardless of identity (students, staff, unidentified devices alike).
// Selected via the dns_network_policy_id setting; falls back to the bare
// default-blocked-categories passthrough if none is configured. This is
// deliberately NOT student/OU-aware — that finer per-OU layer is the
// extension's job (it can only add restrictions on top, never remove
// anything the floor blocks).
// ---------------------------------------------------------------------------
const NETWORK_POLICY_KEY = 'classguard:policy:network-floor';
const NETWORK_POLICY_TTL = 60;

async function resolveNetworkPolicy() {
  const cached = await redis.get(NETWORK_POLICY_KEY).catch(() => null);
  if (cached) { try { return JSON.parse(cached); } catch {} }

  const { rows } = await query('SELECT * FROM policies WHERE is_network_policy = true LIMIT 1');
  const policy = rows[0] || null;

  const result = await buildResolvedPolicy(policy);
  await redis.set(NETWORK_POLICY_KEY, JSON.stringify(result), 'EX', NETWORK_POLICY_TTL)
    .catch(() => {});
  return result;
}

async function invalidateNetworkPolicy() {
  await redis.del(NETWORK_POLICY_KEY);
}

module.exports = {
  resolvePolicy, invalidatePolicy, invalidatePoliciesForClass,
  resolveNetworkPolicy, invalidateNetworkPolicy,
  buildResolvedPolicy, explainPolicyChain,
};
