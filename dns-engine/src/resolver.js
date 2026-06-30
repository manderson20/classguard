const DNS            = require('dns2');
const { Packet }     = DNS;
const blocklist      = require('./blocklistLoader');
const categoryLookup = require('./categoryLookup');
const localRecords   = require('./localRecords');
const cache          = require('./cache');
const upstream       = require('./upstream');
const policyCache    = require('./policyCache');
const { logQuery }   = require('./logger');

function isInAllowList(domain, allowList) {
  if (!allowList || allowList.length === 0) return false;
  const lower = domain.toLowerCase();
  return allowList.some(entry => {
    const e = entry.toLowerCase();
    return lower === e || lower.endsWith(`.${e}`);
  });
}

/**
 * Core resolution function — DNS answer is returned BEFORE the log write.
 * All logQuery() calls are fire-and-forget to keep resolution latency near zero.
 */
async function resolveQuery(name, typeNum, sourceIp) {
  const domain    = name.toLowerCase().replace(/\.$/, '');
  let   studentId = null;
  let   deviceId  = null;
  let   policyId  = null;

  // --- 0. Local authoritative records (managed in ClassGuard) -------------
  // Checked before all filtering — infrastructure queries (printers, servers)
  // are answered directly without touching the student policy pipeline.
  const localAnswers = await localRecords.lookupLocal(domain, typeNum).catch(() => null);
  if (localAnswers !== null) {
    // null = not our zone; empty array = our zone but no record (NXDOMAIN)
    logQuery({ domain, action: 'local', sourceIp, studentId: null, deviceId: null, policyId: null, lessonSessionId: null, blockReason: null });
    return { action: 'allowed', answers: localAnswers };
  }

  // --- 1. Conditional forwarding zones — highest priority of all ----------
  // AD internal zones (school.local, corp.example.com) go directly to the
  // configured DC/resolver. No filtering, no logging of internal queries.
  const fwdZones = await policyCache.getForwardZones().catch(() => []);
  const fwdZone  = fwdZones.find(z => domain === z.domain || domain.endsWith(`.${z.domain}`));
  if (fwdZone) {
    const answers = await forwardToSpecific(domain, typeNum, fwdZone.forwardTo);
    return { action: 'allowed', answers };
  }

  // --- 2. Device lookup ---------------------------------------------------
  const device = await policyCache.getDevice(sourceIp).catch(() => null);
  if (device) {
    studentId = device.studentId;
    deviceId  = device.deviceId;
    policyId  = device.policyId;
  }

  // --- 3. Policy load -----------------------------------------------------
  // DNS-level filtering is now a single network-wide floor, enforced for
  // EVERY query regardless of identity — the per-student/OU policy chain is
  // extension-only (it can only add restrictions on top of the floor, never
  // remove from it; the extension also has URL-path granularity DNS can't).
  // The one identity-aware exception is mode: an active lesson session or
  // penalty box is a deliberate, temporal full-network override and still
  // needs to be enforced here, not just at the extension.
  let policy;
  if (studentId) {
    const ouPolicy = await policyCache.getPolicy(studentId, sourceIp).catch(() => null);
    if (ouPolicy?.mode === 'lesson' || ouPolicy?.mode === 'penalty_box') {
      policy = ouPolicy;
    } else {
      policy = await policyCache.getNetworkPolicy().catch(() => null);
    }
  } else {
    const subnetPolicy = await policyCache.getSubnetPolicy(sourceIp).catch(() => null);
    policy = subnetPolicy || await policyCache.getNetworkPolicy().catch(() => null);
  }
  const mode   = policy?.mode || 'standard';
  // Only meaningful while an active lesson is the thing actually deciding
  // this query (mode === 'lesson') — used to tag dns_logs so a teacher can
  // later scope a student's history to just this lesson session.
  const lessonSessionId = mode === 'lesson' ? (policy.lessonSessionId || null) : null;

  const allowList = [
    ...(policy?.resolvedAllowDomains || []),
  ];

  // --- 3.5. Dry-run mode check --------------------------------------------
  // When active, every filtering decision that would normally block is
  // logged as 'dry_run_blocked' and the query is forwarded anyway.
  // Local records and conditional forwarding zones (above) are unaffected —
  // they are infrastructure, not content filtering.
  const dryRunState = await policyCache.getDryRunState().catch(() => ({ active: false }));
  const isDryRun = dryRunState.active;

  // --- 4. Global whitelist override (managed bookmarks / admin allowlist) --
  // This runs before ANY policy block including lesson/penalty_box mode.
  const globalAllowList = await policyCache.getGlobalAllowlist().catch(() => []);
  if (isInAllowList(domain, globalAllowList)) {
    return forwardAndLog(domain, typeNum, sourceIp, studentId, deviceId, policyId, lessonSessionId);
  }

  // --- 5. Explicit allow-list check (per-policy) --------------------------
  if (isInAllowList(domain, allowList)) {
    return forwardAndLog(domain, typeNum, sourceIp, studentId, deviceId, policyId, lessonSessionId);
  }

  // --- 6. Mode-based restrictions -----------------------------------------
  if (mode === 'penalty_box') {
    if (isDryRun) {
      logQuery({ domain, action: 'dry_run_blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'penalty_box', dryRun: true });
      return dryRunForward(domain, typeNum);
    }
    logQuery({ domain, action: 'blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'penalty_box' });
    return { action: 'blocked', answers: [], blockReason: 'penalty_box' };
  }

  if (mode === 'lesson') {
    if (isDryRun) {
      logQuery({ domain, action: 'dry_run_blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'lesson_mode', dryRun: true });
      return dryRunForward(domain, typeNum);
    }
    logQuery({ domain, action: 'blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'lesson_mode' });
    return { action: 'blocked', answers: [], blockReason: 'lesson_mode' };
  }

  if (mode === 'open') {
    return forwardAndLog(domain, typeNum, sourceIp, studentId, deviceId, policyId, lessonSessionId);
  }

  // --- 6.5. Override code check -------------------------------------------
  // Admin-generated temporary codes bypass blocklist/category blocks.
  // Does NOT bypass penalty_box or lesson modes (those are checked above).
  // CIPA-floor categories cannot receive codes (enforced at code generation).
  if (mode === 'standard') {
    const hasOverride = await policyCache.getOverrideForIp(sourceIp, domain).catch(() => false);
    if (hasOverride) {
      return forwardAndLog(domain, typeNum, sourceIp, studentId, deviceId, policyId, lessonSessionId);
    }
  }

  // --- 6.8. Default-deny check -------------------------------------------
  // Policies with defaultAction='block' (allowlist-only mode) block every
  // domain that didn't pass the allowlist checks above. Blocklists and
  // category rules are irrelevant here — we're already blocking everything.
  if (mode === 'standard' && (policy?.defaultAction || 'allow') === 'block') {
    if (isDryRun) {
      logQuery({ domain, action: 'dry_run_blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'default_deny', dryRun: true });
      return dryRunForward(domain, typeNum);
    }
    logQuery({ domain, action: 'blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'default_deny' });
    return { action: 'blocked', answers: [], blockReason: 'default_deny' };
  }

  // --- 7. Blocklist check (standard mode) ---------------------------------
  // Fails CLOSED: if Redis can't be reached to check the blocklist, we cannot
  // verify safety, so the query is blocked rather than let through unchecked.
  // Dry-run bypasses even this — the point is to see what resolves unfiltered.
  let blocked;
  try {
    blocked = await blocklist.isBlocked(domain);
  } catch {
    if (isDryRun) {
      logQuery({ domain, action: 'dry_run_blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'safety_check_unavailable', dryRun: true });
      return dryRunForward(domain, typeNum);
    }
    logQuery({ domain, action: 'blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'safety_check_unavailable' });
    return { action: 'blocked', answers: [], blockReason: 'safety_check_unavailable' };
  }
  if (blocked) {
    if (isDryRun) {
      logQuery({ domain, action: 'dry_run_blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'blocklist', dryRun: true });
      return dryRunForward(domain, typeNum);
    }
    logQuery({ domain, action: 'blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'blocklist' });
    return { action: 'blocked', answers: [], blockReason: 'blocklist' };
  }

  // --- 7.5. Category check ------------------------------------------------
  // One Redis HGET (pipelined across parent domains) — sub-millisecond.
  // Fails CLOSED, same rationale as the blocklist check above.
  let category;
  try {
    category = await categoryLookup.getCategoryForDomain(domain);
  } catch {
    if (isDryRun) {
      logQuery({ domain, action: 'dry_run_blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'safety_check_unavailable', dryRun: true });
      return dryRunForward(domain, typeNum);
    }
    logQuery({ domain, action: 'blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'safety_check_unavailable' });
    return { action: 'blocked', answers: [], blockReason: 'safety_check_unavailable' };
  }
  const blockedCats    = policy?.blockedCategories || [];

  if (category && blockedCats.includes(category)) {
    if (isDryRun) {
      logQuery({ domain, action: 'dry_run_blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: `category:${category}`, dryRun: true });
      return dryRunForward(domain, typeNum);
    }
    logQuery({ domain, action: 'blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: `category:${category}` });
    return { action: 'blocked', answers: [], blockReason: `category:${category}` };
  }

  // --- 8. Allowed — forward to upstream -----------------------------------
  return forwardAndLog(domain, typeNum, sourceIp, studentId, deviceId, policyId, lessonSessionId);
}

/**
 * Forward to upstream and log the outcome — shared by every call site above.
 * A domain that genuinely doesn't resolve (NXDOMAIN/SERVFAIL/REFUSED, or the
 * upstream being unreachable) is treated as blocked so the student lands on
 * the block page instead of a bare, confusing browser DNS error. This is
 * distinct from a domain that exists but simply has no record of the
 * queried type (e.g. AAAA-only domain queried for A) — forwardToUpstream()
 * only returns null for the former; the latter still returns a normal,
 * empty answers array and is left alone.
 */
/**
 * Forward and return real answers without blocking — used by all dry-run call
 * sites. The log entry is written by the caller (with the specific blockReason)
 * before this is called, so we don't log again here.
 */
async function dryRunForward(domain, typeNum) {
  const { answers } = await forwardToUpstream(domain, typeNum);
  return { action: 'dry_run_blocked', answers: answers || [] };
}

async function forwardAndLog(domain, typeNum, sourceIp, studentId, deviceId, policyId, lessonSessionId = null) {
  const { answers, cacheHit } = await forwardToUpstream(domain, typeNum);
  if (answers === null) {
    logQuery({ domain, action: 'blocked', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: 'unresolvable' });
    return { action: 'blocked', answers: [], blockReason: 'unresolvable' };
  }
  logQuery({ domain, action: 'allowed', sourceIp, studentId, deviceId, policyId, lessonSessionId, blockReason: null, cacheHit });
  return { action: 'allowed', answers };
}

// rcodes that mean "this name does not actually resolve" — distinct from
// NOERROR-with-zero-answers, which just means the domain exists but has no
// record of the queried type (a totally normal, common case: an AAAA-only
// domain queried for A, a CNAME-only name, etc.) and must NOT be treated as
// a failure or it would block-page perfectly healthy sites.
const UNRESOLVABLE_RCODES = new Set([
  Packet.RCODE.NXDOMAIN, Packet.RCODE.SERVFAIL, Packet.RCODE.REFUSED,
]);

/**
 * Forward to upstream resolver with Redis response caching.
 * Returns null (not []) when the domain genuinely doesn't resolve, so
 * callers can route that case to the block page instead of silently
 * returning an empty-but-valid-looking response.
 */
async function forwardToUpstream(domain, typeNum) {
  const cached = await cache.get(domain, typeNum);
  if (cached) return { answers: cached, cacheHit: true };

  try {
    const result = await upstream.resolve(domain, typeNum);
    if (UNRESOLVABLE_RCODES.has(result?.header?.rcode)) return { answers: null, cacheHit: false };

    const answers = result?.answers || [];
    if (answers.length > 0) {
      await cache.set(domain, typeNum, answers);
    }
    return { answers, cacheHit: false };
  } catch {
    // Transport failure (timeout, every configured upstream unreachable) —
    // same "doesn't resolve" treatment as an explicit NXDOMAIN/SERVFAIL.
    return { answers: null, cacheHit: false };
  }
}

/**
 * Forward to a specific DNS server (used for conditional forwarding zones).
 * Bypasses the normal upstream and the cache — AD DNS changes frequently and
 * caching internal zones would cause stale records.
 */
async function forwardToSpecific(domain, typeNum, serverIp) {
  const DNS2 = require('dns2');
  const TYPE_NAMES = { 1:'A', 2:'NS', 5:'CNAME', 6:'SOA', 12:'PTR', 15:'MX', 16:'TXT', 28:'AAAA', 33:'SRV', 255:'ANY' };
  try {
    const client  = new DNS2({ dns: serverIp, retries: 1, timeout: 3000 });
    const result  = await client.resolve(domain, TYPE_NAMES[typeNum] || 'A');
    return result?.answers || [];
  } catch {
    return [];
  }
}

async function buildResponse(request, result) {
  const response = Packet.createResponseFromRequest(request);
  const [question] = request.questions;

  if (result.action === 'blocked') {
    // block_page_ip/block_page_ipv6 are DB-backed (Settings -> DNS &
    // Retention), live-read here the same way the rest of policyCache.js
    // works — config.js's env values are just the fallback for a fresh
    // install where nobody's touched that page yet.
    const settings = await policyCache.getDnsEngineSettings();

    // Match the sinkhole record type to the question type — previously this
    // always pushed an A record regardless of whether the question was A or
    // AAAA, which for an AAAA query meant a type-mismatched answer (not a
    // real NXDOMAIN, but no valid AAAA record either — most clients would
    // just treat it as "no IPv6 address" and fall back to the, correctly
    // sinkholed, A record). Same safe outcome either way, but worth doing
    // properly now that there's an actual AAAA sinkhole to push.
    if (question?.type === Packet.TYPE.AAAA) {
      if (settings.blockPageIpv6) {
        response.answers.push({
          name:    question.name,
          type:    Packet.TYPE.AAAA,
          class:   Packet.CLASS.IN,
          ttl:     5,
          address: settings.blockPageIpv6,
        });
      } else {
        response.header.rcode = Packet.RCODE.NXDOMAIN;
      }
    } else if (question && settings.blockPageIp) {
      response.answers.push({
        name:    question.name,
        type:    Packet.TYPE.A,
        class:   Packet.CLASS.IN,
        ttl:     5,
        address: settings.blockPageIp,
      });
    } else {
      response.header.rcode = Packet.RCODE.NXDOMAIN;
    }
  } else {
    response.answers = result.answers || [];
  }

  return response;
}

module.exports = { resolveQuery, buildResponse };
