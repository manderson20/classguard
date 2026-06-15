const DNS            = require('dns2');
const { Packet }     = DNS;
const config         = require('./config');
const blocklist      = require('./blocklistLoader');
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
  let   policyId  = null;

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
  const device = await policyCache.getDevice(sourceIp);
  if (device) {
    studentId = device.studentId;
    policyId  = device.policyId;
  }

  // --- 3. Policy load -----------------------------------------------------
  const policy = await policyCache.getPolicy(studentId);
  const mode   = policy?.mode || 'standard';

  const allowList = [
    ...(policy?.resolvedAllowDomains || []),
  ];

  // --- 4. Global whitelist override (managed bookmarks / admin allowlist) --
  // This runs before ANY policy block including lesson/penalty_box mode.
  const globalAllowList = await policyCache.getGlobalAllowlist().catch(() => []);
  if (isInAllowList(domain, globalAllowList)) {
    const answers = await forwardToUpstream(domain, typeNum);
    logQuery({ domain, action: 'allowed', sourceIp, studentId, policyId, blockReason: null });
    return { action: 'allowed', answers };
  }

  // --- 5. Explicit allow-list check (per-policy) --------------------------
  if (isInAllowList(domain, allowList)) {
    const answers = await forwardToUpstream(domain, typeNum);
    logQuery({ domain, action: 'allowed', sourceIp, studentId, policyId, blockReason: null });
    return { action: 'allowed', answers };
  }

  // --- 6. Mode-based restrictions -----------------------------------------
  if (mode === 'penalty_box') {
    logQuery({ domain, action: 'blocked', sourceIp, studentId, policyId, blockReason: 'penalty_box' });
    return { action: 'blocked', answers: [], blockReason: 'penalty_box' };
  }

  if (mode === 'lesson') {
    logQuery({ domain, action: 'blocked', sourceIp, studentId, policyId, blockReason: 'lesson_mode' });
    return { action: 'blocked', answers: [], blockReason: 'lesson_mode' };
  }

  if (mode === 'open') {
    const answers = await forwardToUpstream(domain, typeNum);
    logQuery({ domain, action: 'allowed', sourceIp, studentId, policyId, blockReason: null });
    return { action: 'allowed', answers };
  }

  // --- 7. Blocklist check (standard mode) ---------------------------------
  const blocked = await blocklist.isBlocked(domain);
  if (blocked) {
    logQuery({ domain, action: 'blocked', sourceIp, studentId, policyId, blockReason: 'blocklist' });
    return { action: 'blocked', answers: [], blockReason: 'blocklist' };
  }

  // --- 8. Allowed — forward to upstream -----------------------------------
  const answers = await forwardToUpstream(domain, typeNum);
  logQuery({ domain, action: 'allowed', sourceIp, studentId, policyId, blockReason: null });
  return { action: 'allowed', answers };
}

/**
 * Forward to upstream resolver with Redis response caching.
 */
async function forwardToUpstream(domain, typeNum) {
  const cached = await cache.get(domain, typeNum);
  if (cached) return cached;

  try {
    const result  = await upstream.resolve(domain, typeNum);
    const answers = result?.answers || [];
    if (answers.length > 0) {
      await cache.set(domain, typeNum, answers);
    }
    return answers;
  } catch {
    return [];
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

function buildResponse(request, result) {
  const response = Packet.createResponseFromRequest(request);

  if (result.action === 'blocked') {
    if (config.dns.blockPageIp) {
      const [question] = request.questions;
      if (question) {
        response.answers.push({
          name:    question.name,
          type:    Packet.TYPE.A,
          class:   Packet.CLASS.IN,
          ttl:     5,
          address: config.dns.blockPageIp,
        });
      }
    } else {
      response.header.rcode = Packet.RCODE.NXDOMAIN;
    }
  } else {
    response.answers = result.answers || [];
  }

  return response;
}

module.exports = { resolveQuery, buildResponse };
