const redis  = require('./redis');
const axios  = require('axios');
const config = require('./config');

const POLICY_TTL         = 60;   // seconds
const DEVICE_TTL         = 300;
const ALLOWLIST_TTL      = 300;
const SUBNET_POLICY_TTL  = 60;
const ALLOWLIST_KEY      = 'classguard:global-allowlist';
const SUBNET_POLICIES_KEY = 'classguard:dns:subnet-policies';
const DEFAULT_POLICY = { mode: 'standard', resolvedAllowDomains: [], resolvedDenyDomains: [], activeBloclistIds: [], blockedCategories: [], allowedCategories: [] };

function policyKey(studentId) { return `student:policy:${studentId}`; }
function deviceKey(ip)        { return `device:${ip}`; }

/**
 * Look up the device record for a source IP.
 * Returns { studentId, policyId } or null if unknown.
 */
async function getDevice(ip) {
  const raw = await redis.get(deviceKey(ip));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Register or refresh a device→student mapping in Redis.
 * Called by the backend when a device checks in.
 */
async function setDevice(ip, studentId, policyId) {
  await redis.set(deviceKey(ip), JSON.stringify({ studentId, policyId }), 'EX', DEVICE_TTL);
}

/**
 * Load the effective policy for a student.
 * Tries Redis cache first; falls back to the backend API.
 * Returns the default pass-through policy if the student is unknown.
 */
async function getPolicy(studentId) {
  if (!studentId) return DEFAULT_POLICY;

  const raw = await redis.get(policyKey(studentId));
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }

  // Cache miss — fetch from backend API
  try {
    const { data } = await axios.get(
      `${config.backend.url}/api/v1/users/${studentId}/effective-policy`,
      {
        headers: { 'x-internal-secret': config.backend.internalSecret },
        timeout: 2000,
      }
    );
    await redis.set(policyKey(studentId), JSON.stringify(data), 'EX', POLICY_TTL);
    return data;
  } catch {
    // Backend unreachable — default to standard (don't block everything)
    return DEFAULT_POLICY;
  }
}

/**
 * Invalidate a student's policy cache (called when policy changes).
 */
async function invalidatePolicy(studentId) {
  await redis.del(policyKey(studentId));
}

/**
 * Global allowlist — managed bookmarks and admin overrides.
 * Cached in Redis for 5 minutes; fetched from backend API on miss.
 * Applied BEFORE any policy block — if a domain is here it's always allowed.
 */
async function getGlobalAllowlist() {
  const raw = await redis.get(ALLOWLIST_KEY).catch(() => null);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  try {
    const { data } = await axios.get(
      `${config.backend.url}/api/v1/ai/allowlist`,
      {
        headers: { 'x-internal-secret': config.backend.internalSecret },
        timeout: 2000,
      }
    );
    const domains = Array.isArray(data) ? data.map(r => r.domain) : [];
    await redis.set(ALLOWLIST_KEY, JSON.stringify(domains), 'EX', ALLOWLIST_TTL);
    return domains;
  } catch {
    return [];
  }
}

async function invalidateGlobalAllowlist() {
  await redis.del(ALLOWLIST_KEY);
}

// ---------------------------------------------------------------------------
// Conditional forwarding zones — loaded from backend, cached 5 minutes.
// Returns array of { domain, forward_to } for matching against query names.
// ---------------------------------------------------------------------------
const FORWARD_ZONES_KEY = 'classguard:forward-zones';
const FORWARD_ZONES_TTL = 300;

async function getForwardZones() {
  const raw = await redis.get(FORWARD_ZONES_KEY).catch(() => null);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  try {
    const { data } = await axios.get(
      `${config.backend.url}/api/v1/network/dns-forward-zones`,
      {
        headers: { 'x-internal-secret': config.backend.internalSecret },
        timeout: 2000,
      }
    );
    const zones = (Array.isArray(data) ? data : [])
      .filter(z => z.is_active)
      .map(z => ({ domain: z.domain.toLowerCase(), forwardTo: z.forward_to }));
    await redis.set(FORWARD_ZONES_KEY, JSON.stringify(zones), 'EX', FORWARD_ZONES_TTL);
    return zones;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Subnet-based policy lookup for devices without a registered student
// (iPads, BYOD, guest networks — DNS filtering without the extension)
// ---------------------------------------------------------------------------

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.reduce((acc, b) => ((acc * 256) >>> 0) + parseInt(b, 10), 0) >>> 0;
}

function ipInSubnet(ip, cidr) {
  try {
    const [network, bits] = cidr.split('/');
    const prefixLen = bits !== undefined ? parseInt(bits, 10) : 32;
    const mask      = prefixLen === 0 ? 0 : ((~0 << (32 - prefixLen)) >>> 0);
    const ipInt     = ipToInt(ip);
    const netInt    = ipToInt(network);
    if (ipInt === null || netInt === null) return false;
    return (ipInt & mask) === (netInt & mask);
  } catch {
    return false;
  }
}

async function getSubnetPolicy(ip) {
  let assignments;
  const raw = await redis.get(SUBNET_POLICIES_KEY).catch(() => null);
  if (raw) {
    try { assignments = JSON.parse(raw); } catch {}
  }

  if (!assignments) {
    try {
      const { data } = await axios.get(
        `${config.backend.url}/api/v1/policies/subnet-assignments`,
        {
          headers: { 'x-internal-secret': config.backend.internalSecret },
          timeout: 2000,
        }
      );
      assignments = Array.isArray(data) ? data : [];
      await redis.set(SUBNET_POLICIES_KEY, JSON.stringify(assignments), 'EX', SUBNET_POLICY_TTL);
    } catch {
      return null;
    }
  }

  // Most-specific (longest prefix) subnet wins
  let match = null;
  let matchBits = -1;
  for (const entry of assignments) {
    if (!entry.subnet || !entry.policy) continue;
    const bits = parseInt(entry.subnet.split('/')[1] ?? '32', 10);
    if (bits > matchBits && ipInSubnet(ip, entry.subnet)) {
      match     = entry.policy;
      matchBits = bits;
    }
  }
  return match || null;
}

async function invalidateSubnetPolicies() {
  await redis.del(SUBNET_POLICIES_KEY);
}

// ---------------------------------------------------------------------------
// Override code check — set by the backend when a valid override code is used.
// Key: classguard:override:{ip}:{domain}, TTL = remaining code validity.
// ---------------------------------------------------------------------------
async function getOverrideForIp(ip, domain) {
  try {
    const val = await redis.get(`classguard:override:${ip}:${domain}`);
    return val !== null;
  } catch { return false; }
}

module.exports = {
  getDevice, setDevice, getPolicy, invalidatePolicy,
  getGlobalAllowlist, invalidateGlobalAllowlist,
  getForwardZones,
  getSubnetPolicy, invalidateSubnetPolicies,
  getOverrideForIp,
};
