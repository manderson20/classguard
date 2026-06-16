const BASE = import.meta.env.VITE_API_URL || '';

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('cg_token');

  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    localStorage.removeItem('cg_token');
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.error || `Request failed: ${res.status}`);
    Object.assign(error, err); // carry overlap, conflicting, etc. through to callers
    throw error;
  }

  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get:    (path)        => apiFetch(path),
  post:   (path, body)  => apiFetch(path, { method: 'POST',   body }),
  patch:  (path, body)  => apiFetch(path, { method: 'PATCH',  body }),
  put:    (path, body)  => apiFetch(path, { method: 'PUT',    body }),
  delete: (path)        => apiFetch(path, { method: 'DELETE' }),
};

export default api;
