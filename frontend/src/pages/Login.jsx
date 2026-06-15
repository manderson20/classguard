import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../lib/api';
import logo from '../assets/logo.png';

const REDIRECT_URI = `${window.location.origin}/auth/callback`;

function buildOAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export default function Login() {
  const { user, login } = useAuth();
  const navigate        = useNavigate();
  const [searchParams]  = useSearchParams();

  const [googleClientId, setGoogleClientId] = useState(null);
  const [configLoaded, setConfigLoaded]     = useState(false);
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  // Check first-run, then load public config (Google client ID)
  useEffect(() => {
    async function init() {
      try {
        const { needsSetup } = await api.get('/auth/setup-status');
        if (needsSetup) { navigate('/setup', { replace: true }); return; }
      } catch { /* DB might not be ready yet; stay on login */ }

      try {
        const cfg = await api.get('/auth/public-config');
        setGoogleClientId(cfg.googleClientId || null);
      } catch { /* Google not configured */ }

      setConfigLoaded(true);
    }
    init();
  }, [navigate]);

  const oauthError = searchParams.get('error');

  async function handleLocalLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await api.post('/auth/login', { email, password });
      await login(token);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || 'Invalid email or password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-700 to-primary-900 p-4">
      <div className="bg-white rounded-2xl shadow-2xl p-10 w-full max-w-sm">
        <div className="text-center mb-8">
          <img src={logo} alt="ClassGuard" className="w-48 h-auto mx-auto mb-2" />
          <p className="text-slate-500 text-sm">School internet safety &amp; classroom management</p>
        </div>

        {oauthError && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-center">
            {oauthError === 'insufficient_role' ? 'Your account does not have access.' : oauthError}
          </div>
        )}

        {/* Local login form */}
        <form onSubmit={handleLocalLogin} className="space-y-3 mb-5">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder="admin@school.org"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-primary-600 text-white text-sm font-semibold
                       hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* Google OAuth button — only shown when a client ID is configured */}
        {configLoaded && googleClientId && (
          <>
            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 border-t border-slate-200" />
              <span className="text-xs text-slate-400">or</span>
              <div className="flex-1 border-t border-slate-200" />
            </div>

            <a
              href={buildOAuthUrl(googleClientId)}
              className="flex items-center justify-center gap-3 w-full px-4 py-2.5 border-2 border-slate-200
                         rounded-xl text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
              </svg>
              Sign in with Google
            </a>

            <p className="mt-4 text-center text-xs text-slate-400">
              Use your school Google Workspace account
            </p>
          </>
        )}
      </div>
    </div>
  );
}
