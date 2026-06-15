import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../lib/api';

export default function AuthCallback() {
  const { login }  = useAuth();
  const navigate   = useNavigate();
  const processed  = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const error  = params.get('error');

    if (error || !code) {
      navigate('/login?error=' + encodeURIComponent(error || 'missing_code'), { replace: true });
      return;
    }

    api.post('/auth/google', {
      code,
      redirect_uri: `${window.location.origin}/auth/callback`,
    })
      .then(({ token }) => login(token))
      .then((user) => {
        // Students don't have access to the teacher dashboard
        if (user.role === 'student') {
          localStorage.removeItem('cg_token');
          navigate('/login?error=student_not_allowed', { replace: true });
        } else {
          navigate('/', { replace: true });
        }
      })
      .catch((err) => {
        console.error('Auth callback error:', err);
        navigate('/login?error=' + encodeURIComponent(err.message), { replace: true });
      });
  }, [login, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="text-4xl mb-4">🛡️</div>
        <p className="text-slate-600 text-sm">Signing you in…</p>
      </div>
    </div>
  );
}
