const redis  = require('./redis');
const axios  = require('axios');
const config = require('./config');

const POLICY_TTL    = 60;  // seconds
const DEVICE_TTL    = 300;
const DEFAULT_POLICY = { mode: 'standard', resolvedAllowDomains: [], resolvedDenyDomains: [], activeBloclistIds: [] };

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

module.exports = { getDevice, setDevice, getPolicy, invalidatePolicy };
