const BASE = import.meta.env.VITE_API_URL || '';

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('cg_token');
  const isFormData = options.body instanceof FormData;

  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...options,
    headers: {
      // Omit Content-Type for FormData — browser sets it with the boundary automatically.
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: isFormData ? options.body : options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  // A 401 from a credential submission means "wrong credentials" and belongs
  // to the caller's own error handling; a 401 from anything else means the
  // session died. Handled with a redirect rather than alert() — a blocking
  // dialog in this wrapper freezes the page mid-redirect (and a queued pile
  // of them from parallel requests can wedge navigation outright). The login
  // page shows the expired-session message via the query param instead.
  const isCredentialSubmit = path.startsWith('/auth/login') || path.startsWith('/auth/google');
  if (res.status === 401 && !isCredentialSubmit) {
    localStorage.removeItem('cg_token');
    if (window.location.pathname !== '/login') {
      window.location.replace('/login?error=session_expired');
    }
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
  get:    (path, opts)  => apiFetch(path, opts),
  post:   (path, body)  => apiFetch(path, { method: 'POST',   body }),
  patch:  (path, body)  => apiFetch(path, { method: 'PATCH',  body }),
  put:    (path, body)  => apiFetch(path, { method: 'PUT',    body }),
  delete: (path, body)  => apiFetch(path, { method: 'DELETE', ...(body !== undefined ? { body } : {}) }),
};

export default api;
