import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../lib/api';

const AuthContext = createContext(null);

function decodeJWT(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser]     = useState(null);
  const [loading, setLoading] = useState(true);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const token = localStorage.getItem('cg_token');
    if (token) {
      const payload = decodeJWT(token);
      if (payload) {
        // Fetch full user profile from backend
        api.get('/auth/me')
          .then(setUser)
          .catch(() => { localStorage.removeItem('cg_token'); })
          .finally(() => setLoading(false));
      } else {
        localStorage.removeItem('cg_token');
        setLoading(false);
      }
    } else {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (token) => {
    localStorage.setItem('cg_token', token);
    const profile = await api.get('/auth/me');
    setUser(profile);
    return profile;
  }, []);

  const refreshUser = useCallback(async () => {
    const profile = await api.get('/auth/me');
    setUser(profile);
    return profile;
  }, []);

  const logout = useCallback(async () => {
    await api.delete('/auth/logout').catch(() => {});
    localStorage.removeItem('cg_token');
    localStorage.removeItem('cg_admin_token');
    setUser(null);
  }, []);

  // Stashes the admin's own token under a separate key before swapping
  // cg_token for the short-lived impersonation token, so "exit" can restore
  // it without a re-login. Survives a page reload -- cg_admin_token is
  // still there, and re-hydrating cg_token (the impersonation token) on
  // mount naturally re-shows the banner via /auth/me's impersonatedBy field.
  const startImpersonation = useCallback(async (teacherId) => {
    const { token } = await api.post(`/impersonation/${teacherId}/start`, {});
    localStorage.setItem('cg_admin_token', localStorage.getItem('cg_token'));
    localStorage.setItem('cg_token', token);
    const profile = await api.get('/auth/me');
    setUser(profile);
    return profile;
  }, []);

  const endImpersonation = useCallback(async () => {
    await api.post('/impersonation/end', {}).catch(() => {});
    const adminToken = localStorage.getItem('cg_admin_token');
    localStorage.removeItem('cg_admin_token');
    if (adminToken) {
      localStorage.setItem('cg_token', adminToken);
      const profile = await api.get('/auth/me');
      setUser(profile);
      return profile;
    }
    localStorage.removeItem('cg_token');
    setUser(null);
    return null;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser, startImpersonation, endImpersonation }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
