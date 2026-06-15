// Thin REST client for the ClassGuard backend API.
// Works in both service workers and page contexts.

/* global __BACKEND_URL__ */
const BASE = __BACKEND_URL__;

/**
 * @param {string} path   e.g. '/extension/auth'
 * @param {object} opts
 * @param {string} [opts.method]
 * @param {string|null} [opts.jwt]    — pass null to skip Authorization header
 * @param {object} [opts.body]
 */
export async function apiFetch(path, { method = 'GET', jwt = undefined, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (jwt !== null) {
    const token = jwt || (await getJWT());
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`API ${method} ${path} → ${res.status}: ${detail}`);
  }

  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : null;
}

// Lazy import to avoid circular deps — service-worker imports both api.js and auth.js
async function getJWT() {
  const { getStoredJWT } = await import('./auth.js');
  return getStoredJWT();
}
