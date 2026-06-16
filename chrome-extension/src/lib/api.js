// Thin REST client for the ClassGuard backend API.
// Works in both service workers and page contexts.

/* global __BACKEND_URL__ */

// Resolve server URL from Google Admin managed storage at runtime.
// Falls back to the build-time __BACKEND_URL__ constant so local/dev builds still work.
let _resolvedBase = null;

export async function getServerUrl() {
  if (_resolvedBase) return _resolvedBase;
  try {
    const managed = await chrome.storage.managed.get(['serverUrl']);
    _resolvedBase = (managed.serverUrl || __BACKEND_URL__ || '').replace(/\/$/, '');
  } catch {
    // chrome.storage.managed throws in dev / unpacked extension without a managed schema
    _resolvedBase = (__BACKEND_URL__ || '').replace(/\/$/, '');
  }
  return _resolvedBase;
}

/**
 * @param {string} path   e.g. '/extension/auth'
 * @param {object} opts
 * @param {string} [opts.method]
 * @param {string|null} [opts.jwt]    — pass null to skip Authorization header
 * @param {object} [opts.body]
 */
export async function apiFetch(path, { method = 'GET', jwt = undefined, body } = {}) {
  const base    = await getServerUrl();
  const headers = { 'Content-Type': 'application/json' };

  if (jwt !== null) {
    const token = jwt || (await getJWT());
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${base}/api/v1${path}`, {
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
