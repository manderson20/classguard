const redis      = require('../redis');
const { query }  = require('../db');

const POLICY_TTL = 60; // seconds

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function policyKey(studentId) {
  return `student:policy:${studentId}`;
}

async function invalidatePolicy(studentId) {
  await redis.del(policyKey(studentId));
}

async function invalidatePoliciesForClass(classId) {
  const { rows } = await query(
    'SELECT student_id FROM class_members WHERE class_id = $1',
    [classId]
  );
  if (rows.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const { student_id } of rows) {
    pipeline.del(policyKey(student_id));
  }
  await pipeline.exec();
  return rows.map(r => r.student_id);
}

// ---------------------------------------------------------------------------
// Core resolver — full precedence chain
// ---------------------------------------------------------------------------

async function resolvePolicy(studentId) {
  if (!studentId) return defaultPassthrough();

  // --- Cache hit ---
  const cached = await redis.get(policyKey(studentId));
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

  // 3. Student-level policy assignment
  const { rows: studentRows } = await query(
    `SELECT p.* FROM policies p
     JOIN policy_assignments pa ON pa.policy_id = p.id
     WHERE pa.target_type = 'student'
       AND pa.target_id   = $1
     ORDER BY pa.priority DESC
     LIMIT 1`,
    [studentId]
  );
  if (studentRows[0]) policy = studentRows[0];

  // 4. Group-level policy (highest-priority group wins)
  if (!policy) {
    const { rows: groupRows } = await query(
      `SELECT p.*, pa.priority FROM policies p
       JOIN policy_assignments pa ON pa.policy_id = p.id
       JOIN group_members gm     ON gm.group_id   = pa.target_id
       WHERE pa.target_type = 'group'
         AND gm.user_id     = $1
       ORDER BY pa.priority DESC
       LIMIT 1`,
      [studentId]
    );
    if (groupRows[0]) policy = groupRows[0];
  }

  // 5. OU-level policy (most-specific OU prefix wins)
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
         ORDER BY LENGTH(pa.target_ou) DESC
         LIMIT 1`,
        [ou]
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

  // --- Build resolved domain lists from base policy ---
  if (policy) {
    const { rows: ruleRows } = await query(
      'SELECT domain, rule_type FROM policy_domain_rules WHERE policy_id = $1',
      [policy.id]
    );
    resolvedAllowDomains = [
      ...resolvedAllowDomains,
      ...ruleRows.filter(r => r.rule_type === 'allow').map(r => r.domain),
    ];
    resolvedDenyDomains = ruleRows.filter(r => r.rule_type === 'deny').map(r => r.domain);
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

  // --- Category rules for this policy ---
  let blockedCategories = [];
  let allowedCategories = [];
  if (policy) {
    const { rows: catRows } = await query(
      `SELECT wc.slug, pcr.action
       FROM policy_category_rules pcr
       JOIN website_categories wc ON wc.id = pcr.category_id
       WHERE pcr.policy_id = $1`,
      [policy.id]
    );
    blockedCategories = catRows.filter(r => r.action === 'block').map(r => r.slug);
    allowedCategories = catRows.filter(r => r.action === 'allow').map(r => r.slug);
  }

  const result = {
    ...(policy || {}),
    mode:                mode || policy?.mode || 'standard',
    resolvedAllowDomains,
    resolvedDenyDomains,
    activeBloclistIds,
    blockedCategories,
    allowedCategories,
  };

  // Cache the resolved policy
  await redis.set(policyKey(studentId), JSON.stringify(result), 'EX', POLICY_TTL);

  return result;
}

function defaultPassthrough() {
  return {
    mode:                'standard',
    resolvedAllowDomains: [],
    resolvedDenyDomains:  [],
    activeBloclistIds:    [],
  };
}

module.exports = { resolvePolicy, invalidatePolicy, invalidatePoliciesForClass };
