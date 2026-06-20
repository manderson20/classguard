const redis  = require('./redis');
const axios  = require('axios');
const config = require('./config');

const POLICY_TTL         = 60;   // seconds
const DEVICE_TTL         = 300;
const ALLOWLIST_TTL      = 300;
const SUBNET_POLICY_TTL  = 60;
const NETWORK_POLICY_TTL = 60;
const ALLOWLIST_KEY      = 'classguard:global-allowlist';
const SUBNET_POLICIES_KEY = 'classguard:dns:subnet-policies';
const NETWORK_POLICY_KEY  = 'classguard:dns:network-policy';
const DEFAULT_POLICY = { mode: 'standard', resolvedAllowDomains: [], resolvedDenyDomains: [], activeBloclistIds: [], blockedCategories: [], allowedCategories: [] };

function policyKey(studentId, location) { return `student:policy:${studentId}:${location}`; }
function deviceKey(ip)        { return `device:${ip}`; }

/**
 * Look up the device record for a source IP.
 * Returns { studentId, deviceId, policyId } or null if unknown.
 *
 * routes/extension.js writes this key as JSON {studentId, deviceId} on every
 * /register and /heartbeat call. (It used to write a bare studentId string,
 * which this function JSON.parse()'d — always throwing, silently caught,
 * always returning null, so no DNS query was EVER attributed to a student
 * via this path: confirmed live, 0 of several thousand dns_logs rows had a
 * user_id. Fixed alongside switching the wire format to JSON so deviceId —
 * the device's MAC-resolved devices.id, see extension.js — could ride along
 * too.) Old plain-string keys (8h TTL) may still be live right after this
 * deploys, so a bare string is treated as a legacy studentId-only value
 * rather than failing the read.
 */
async function getDevice(ip) {
  const raw = await redis.get(deviceKey(ip));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return { studentId: parsed.studentId, deviceId: parsed.deviceId ?? null, policyId: parsed.policyId ?? null };
  } catch {
    return { studentId: raw, deviceId: null, policyId: null }; // legacy plain-string value
  }
}

/**
 * Register or refresh a device→student mapping in Redis. Not currently
 * called (routes/extension.js writes the key directly), kept for parity —
 * must stay in the same JSON format getDevice() reads.
 */
async function setDevice(ip, studentId, deviceId = null) {
  await redis.set(deviceKey(ip), JSON.stringify({ studentId, deviceId }), 'EX', DEVICE_TTL);
}

/**
 * Load the effective policy for a student, location-aware: on-campus vs
 * off-campus is classified from sourceIp against documented school subnets,
 * so a student's OU/group/student-level assignment can differ by location
 * (e.g. a more restrictive policy while physically at school).
 * Tries Redis cache first; falls back to the backend API.
 * Returns the default pass-through policy if the student is unknown.
 */
async function getPolicy(studentId, sourceIp) {
  if (!studentId) return DEFAULT_POLICY;

  const location = await resolveLocation(sourceIp);
  const key = policyKey(studentId, location);

  const raw = await redis.get(key);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }

  // Cache miss — fetch from backend API
  try {
    const { data } = await axios.get(
      `${config.backend.url}/api/v1/users/${studentId}/effective-policy`,
      {
        params:  { location },
        headers: { 'x-internal-secret': config.backend.internalSecret },
        timeout: 2000,
      }
    );
    await redis.set(key, JSON.stringify(data), 'EX', POLICY_TTL);
    return data;
  } catch {
    // Backend unreachable — default to standard (don't block everything)
    return DEFAULT_POLICY;
  }
}

/**
 * Invalidate a student's policy cache (called when policy changes) — clears
 * both location variants since we don't know which one is currently cached.
 */
async function invalidatePolicy(studentId) {
  await redis.del(policyKey(studentId, 'on_campus'), policyKey(studentId, 'off_campus'), policyKey(studentId, 'any'));
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

// ---------------------------------------------------------------------------
// On-campus vs off-campus classification — used to pick the right
// location-specific policy assignment for an identified student.
// ---------------------------------------------------------------------------
const ONCAMPUS_SUBNETS_KEY = 'classguard:dns:oncampus-subnets';
const ONCAMPUS_SUBNETS_TTL = 300; // 5 minutes

async function getOnCampusSubnets() {
  const raw = await redis.get(ONCAMPUS_SUBNETS_KEY).catch(() => null);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  try {
    const { data } = await axios.get(
      `${config.backend.url}/api/v1/policies/oncampus-subnets`,
      {
        headers: { 'x-internal-secret': config.backend.internalSecret },
        timeout: 2000,
      }
    );
    const subnets = Array.isArray(data) ? data : [];
    await redis.set(ONCAMPUS_SUBNETS_KEY, JSON.stringify(subnets), 'EX', ONCAMPUS_SUBNETS_TTL);
    return subnets;
  } catch {
    return [];
  }
}

async function resolveLocation(ip) {
  if (!ip) return 'any';
  const subnets = await getOnCampusSubnets();
  return subnets.some(cidr => ipInSubnet(ip, cidr)) ? 'on_campus' : 'off_campus';
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
// Network-wide DNS floor — one policy enforced for EVERY query regardless of
// identity. The per-student/OU chain (getPolicy above) is extension-only now;
// DNS only ever applies this floor (plus lesson/penalty_box mode overrides).
// ---------------------------------------------------------------------------
async function getNetworkPolicy() {
  const raw = await redis.get(NETWORK_POLICY_KEY).catch(() => null);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  try {
    const { data } = await axios.get(
      `${config.backend.url}/api/v1/policies/network-policy`,
      {
        headers: { 'x-internal-secret': config.backend.internalSecret },
        timeout: 2000,
      }
    );
    await redis.set(NETWORK_POLICY_KEY, JSON.stringify(data), 'EX', NETWORK_POLICY_TTL);
    return data;
  } catch {
    return DEFAULT_POLICY;
  }
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
  getNetworkPolicy,
  getOverrideForIp,
  resolveLocation,
};
