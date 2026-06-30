import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../lib/api';
import logo from '../assets/logo.png';

// --------------------------------------------------------------------------
// Step indicator
// --------------------------------------------------------------------------
const STEPS = [
  { id: 1, label: 'School Info' },
  { id: 2, label: 'Google SSO' },
  { id: 3, label: 'HTTPS' },
  { id: 4, label: 'Safety Alerts' },
  { id: 5, label: 'Done' },
];

function StepBar({ current }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((s, i) => (
        <div key={s.id} className="flex items-center gap-0 flex-1">
          <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors
              ${s.id < current  ? 'bg-emerald-500 text-white'
              : s.id === current ? 'bg-primary-600 text-white ring-4 ring-primary-100'
              : 'bg-slate-200 text-slate-500'}`}>
              {s.id < current ? '✓' : s.id}
            </div>
            <span className={`text-[10px] font-medium whitespace-nowrap ${s.id === current ? 'text-primary-600' : 'text-slate-400'}`}>
              {s.label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`h-0.5 flex-1 mx-1 mb-4 ${s.id < current ? 'bg-emerald-400' : 'bg-slate-200'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 1 — School Info
// --------------------------------------------------------------------------
function StepSchoolInfo({ onNext }) {
  const [form, setForm] = useState({ school_name: '', contact_email: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    api.get('/settings')
      .then(d => setForm({
        school_name:   d.blockpage_school_name   || '',
        contact_email: d.blockpage_contact_email || '',
      }))
      .catch(() => {});
  }, []);

  async function save() {
    if (!form.school_name.trim()) { setError('School name is required.'); return; }
    setLoading(true); setError('');
    try {
      await api.post('/settings', {
        blockpage_school_name:   form.school_name.trim(),
        blockpage_contact_email: form.contact_email.trim(),
      });
      onNext();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-slate-800 mb-1">School Information</h2>
        <p className="text-sm text-slate-500">This name appears on your content filter block page when students try to access blocked sites.</p>
      </div>
      <div className="space-y-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">School / District Name <span className="text-red-500">*</span></span>
          <input
            className="input"
            placeholder="e.g. Brookfield R-3 School District"
            value={form.school_name}
            onChange={e => setForm(f => ({ ...f, school_name: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">Admin Contact Email</span>
          <input
            className="input"
            type="email"
            placeholder="e.g. itadmin@yourdistrict.org"
            value={form.contact_email}
            onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))}
          />
          <span className="text-xs text-slate-400">Shown on the block page so students know who to contact.</span>
        </label>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end pt-2">
        <button className="btn btn-primary" onClick={save} disabled={loading}>
          {loading ? 'Saving…' : 'Next →'}
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 2 — Google Workspace SSO
// --------------------------------------------------------------------------
function StepGoogleSSO({ onNext, onSkip }) {
  const [form, setForm] = useState({
    client_id: '', client_secret: '', redirect_uri: '', workspace_domain: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    api.get('/settings').then(d => setForm({
      client_id:        d.google_client_id        || '',
      client_secret:    d.google_client_secret    || '',
      redirect_uri:     d.google_redirect_uri     || '',
      workspace_domain: d.google_workspace_domain || '',
    })).catch(() => {});
  }, []);

  async function save() {
    if (!form.client_id.trim() || !form.client_secret.trim()) {
      setError('Client ID and Client Secret are required.');
      return;
    }
    setLoading(true); setError('');
    try {
      await api.post('/settings', {
        google_client_id:        form.client_id.trim(),
        google_client_secret:    form.client_secret.trim(),
        google_redirect_uri:     form.redirect_uri.trim(),
        google_workspace_domain: form.workspace_domain.trim(),
      });
      onNext();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setLoading(false);
    }
  }

  const alreadyConfigured = !!form.client_id;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-slate-800 mb-1">Google Workspace SSO</h2>
        <p className="text-sm text-slate-500">
          Lets staff sign in with their Google accounts. You'll need a Web Application OAuth 2.0 client from{' '}
          <span className="font-mono text-xs bg-slate-100 px-1 rounded">console.cloud.google.com</span>.
        </p>
        {alreadyConfigured && (
          <div className="mt-3 flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <span>✓</span> Google SSO is already configured.
          </div>
        )}
      </div>
      <div className="space-y-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">Client ID</span>
          <input className="input font-mono text-sm" placeholder="xxxxxxxx.apps.googleusercontent.com"
            value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">Client Secret</span>
          <input className="input font-mono text-sm" type="password" placeholder="GOCSPX-…"
            value={form.client_secret} onChange={e => setForm(f => ({ ...f, client_secret: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">Authorized Redirect URI</span>
          <input className="input font-mono text-sm" placeholder="https://your-domain/auth/callback"
            value={form.redirect_uri} onChange={e => setForm(f => ({ ...f, redirect_uri: e.target.value }))} />
          <span className="text-xs text-slate-400">Must exactly match what you registered in Google Cloud Console.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">Restrict to Domain (optional)</span>
          <input className="input font-mono text-sm" placeholder="yourdistrict.org"
            value={form.workspace_domain} onChange={e => setForm(f => ({ ...f, workspace_domain: e.target.value }))} />
          <span className="text-xs text-slate-400">Only accounts from this domain can sign in. Leave blank to allow any Google account.</span>
        </label>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-between pt-2">
        <button className="btn btn-secondary text-sm" onClick={onSkip}>Skip for now</button>
        <button className="btn btn-primary" onClick={save} disabled={loading}>
          {loading ? 'Saving…' : 'Next →'}
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 3 — HTTPS / TLS
// --------------------------------------------------------------------------
function StepHTTPS({ onNext, onSkip }) {
  const [tlsConfig, setTlsConfig]   = useState(null);
  const [form, setForm]             = useState({ domain: '', provider: 'cloudflare', acme_email: '', cf_token: '', r53_key: '', r53_secret: '' });
  const [loading, setLoading]       = useState(false);
  const [issuing, setIssuing]       = useState(false);
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');

  useEffect(() => {
    api.get('/tls').then(d => {
      setTlsConfig(d);
      setForm(f => ({
        ...f,
        domain:     d.domain      || '',
        provider:   d.provider    || 'cloudflare',
        acme_email: d.acme_email  || '',
        cf_token:   d.cf_token    || '',
        r53_key:    d.r53_key     || '',
        r53_secret: d.r53_secret  || '',
      }));
    }).catch(() => {});
  }, []);

  async function saveAndIssue() {
    if (!form.domain.trim()) { setError('Domain is required.'); return; }
    setIssuing(true); setError(''); setSuccess('');
    try {
      await api.put('/tls', form);
      await api.post('/tls/issue');
      setSuccess('Certificate issued successfully!');
      setTimeout(onNext, 1500);
    } catch (e) {
      setError(e.message || 'Failed to issue certificate.');
    } finally {
      setIssuing(false);
    }
  }

  async function saveOnly() {
    if (!form.domain.trim()) { setError('Domain is required.'); return; }
    setLoading(true); setError('');
    try {
      await api.put('/tls', form);
      onNext();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setLoading(false);
    }
  }

  const hasCert = tlsConfig?.status === 'active';

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-slate-800 mb-1">HTTPS Certificate</h2>
        <p className="text-sm text-slate-500">
          Configure a domain and issue a free Let's Encrypt TLS certificate so ClassGuard is accessible over HTTPS.
        </p>
        {hasCert && (
          <div className="mt-3 flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <span>✓</span> TLS certificate is active — expires {tlsConfig.expiry?.slice(0, 10)}.
          </div>
        )}
      </div>
      <div className="space-y-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">Domain Name</span>
          <input className="input font-mono text-sm" placeholder="classguard.yourdistrict.org"
            value={form.domain} onChange={e => setForm(f => ({ ...f, domain: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">DNS Provider</span>
          <select className="input bg-white" value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}>
            <option value="cloudflare">Cloudflare</option>
            <option value="route53">AWS Route 53</option>
            <option value="manual">Manual DNS challenge</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">ACME Email</span>
          <input className="input" type="email" placeholder="admin@yourdistrict.org"
            value={form.acme_email} onChange={e => setForm(f => ({ ...f, acme_email: e.target.value }))} />
          <span className="text-xs text-slate-400">Let's Encrypt sends renewal notices here.</span>
        </label>
        {form.provider === 'cloudflare' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate-600">Cloudflare API Token</span>
            <input className="input font-mono text-sm" type="password" placeholder="API token with Zone:DNS:Edit"
              value={form.cf_token} onChange={e => setForm(f => ({ ...f, cf_token: e.target.value }))} />
          </label>
        )}
        {form.provider === 'route53' && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-slate-600">AWS Access Key ID</span>
              <input className="input font-mono text-sm" value={form.r53_key}
                onChange={e => setForm(f => ({ ...f, r53_key: e.target.value }))} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-slate-600">AWS Secret Access Key</span>
              <input className="input font-mono text-sm" type="password" value={form.r53_secret}
                onChange={e => setForm(f => ({ ...f, r53_secret: e.target.value }))} />
            </label>
          </>
        )}
        {form.provider === 'manual' && (
          <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
            After saving, go to <strong>Settings → HTTPS</strong> to start the manual DNS challenge flow.
          </div>
        )}
      </div>
      {error   && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm text-emerald-600">{success}</p>}
      <div className="flex justify-between pt-2">
        <button className="btn btn-secondary text-sm" onClick={onSkip}>Skip for now</button>
        <div className="flex gap-2">
          <button className="btn btn-secondary text-sm" onClick={saveOnly} disabled={loading || issuing}>
            {loading ? 'Saving…' : 'Save only'}
          </button>
          {form.provider !== 'manual' && (
            <button className="btn btn-primary" onClick={saveAndIssue} disabled={loading || issuing}>
              {issuing ? 'Issuing…' : 'Save & Issue Cert →'}
            </button>
          )}
          {form.provider === 'manual' && (
            <button className="btn btn-primary" onClick={saveOnly} disabled={loading}>
              Next →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 4 — Safety Alerts
// --------------------------------------------------------------------------
function StepSafetyAlerts({ onNext, onSkip }) {
  const [emails, setEmails]   = useState('');
  const [smtp, setSmtp]       = useState({ host: '', port: '587', secure: 'false', user: '', password: '', from: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/settings/safety-alert-recipients'),
      api.get('/settings'),
    ]).then(([alertData, settingsData]) => {
      setEmails(alertData.safety_alert_emails || '');
      setSmtp({
        host:     settingsData.smtp_host     || '',
        port:     settingsData.smtp_port     || '587',
        secure:   settingsData.smtp_secure   || 'false',
        user:     settingsData.smtp_user     || '',
        password: settingsData.smtp_password || '',
        from:     settingsData.smtp_from     || '',
      });
    }).catch(() => {});
  }, []);

  async function save() {
    setLoading(true); setError('');
    try {
      await Promise.all([
        api.post('/settings/safety-alert-recipients', { safety_alert_emails: emails }),
        api.post('/settings', {
          smtp_host:     smtp.host,
          smtp_port:     smtp.port,
          smtp_secure:   smtp.secure,
          smtp_user:     smtp.user,
          smtp_password: smtp.password,
          smtp_from:     smtp.from,
        }),
      ]);
      onNext();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-slate-800 mb-1">Safety Alerts</h2>
        <p className="text-sm text-slate-500">
          ClassGuard can email counselors and administrators when a student's browsing activity triggers a safety concern (self-harm, violence, etc.).
        </p>
      </div>
      <div className="space-y-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-600">Alert Recipients</span>
          <input className="input" type="email" placeholder="counselor@yourdistrict.org, principal@yourdistrict.org"
            value={emails} onChange={e => setEmails(e.target.value)} />
          <span className="text-xs text-slate-400">Comma-separated email addresses. These people receive safety alert notifications.</span>
        </label>
        <div className="border-t border-slate-100 pt-4">
          <p className="text-xs font-medium text-slate-600 mb-3">Mail Server (SMTP)</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 col-span-2 sm:col-span-1">
              <span className="text-xs text-slate-500">SMTP Host</span>
              <input className="input text-sm" placeholder="smtp.gmail.com"
                value={smtp.host} onChange={e => setSmtp(s => ({ ...s, host: e.target.value }))} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-slate-500">Port</span>
              <input className="input text-sm" placeholder="587"
                value={smtp.port} onChange={e => setSmtp(s => ({ ...s, port: e.target.value }))} />
            </label>
            <label className="flex flex-col gap-1.5 col-span-2 sm:col-span-1">
              <span className="text-xs text-slate-500">Username</span>
              <input className="input text-sm"
                value={smtp.user} onChange={e => setSmtp(s => ({ ...s, user: e.target.value }))} />
            </label>
            <label className="flex flex-col gap-1.5 col-span-2 sm:col-span-1">
              <span className="text-xs text-slate-500">Password / App Password</span>
              <input className="input text-sm" type="password"
                value={smtp.password} onChange={e => setSmtp(s => ({ ...s, password: e.target.value }))} />
            </label>
            <label className="flex flex-col gap-1.5 col-span-2">
              <span className="text-xs text-slate-500">From Address</span>
              <input className="input text-sm" placeholder="classguard@yourdistrict.org"
                value={smtp.from} onChange={e => setSmtp(s => ({ ...s, from: e.target.value }))} />
            </label>
          </div>
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-between pt-2">
        <button className="btn btn-secondary text-sm" onClick={onSkip}>Skip for now</button>
        <button className="btn btn-primary" onClick={save} disabled={loading}>
          {loading ? 'Saving…' : 'Next →'}
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 5 — Done
// --------------------------------------------------------------------------
function StepDone({ onFinish }) {
  return (
    <div className="space-y-6 text-center py-4">
      <div className="flex justify-center">
        <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center text-3xl">✓</div>
      </div>
      <div>
        <h2 className="text-2xl font-semibold text-slate-800 mb-2">ClassGuard is ready!</h2>
        <p className="text-sm text-slate-500 max-w-sm mx-auto">
          You can always revisit any of these settings from the <strong>Settings</strong> and <strong>Integrations</strong> pages in the admin panel.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-left">
        {[
          { icon: '🛡️', title: 'Content Filtering', desc: 'Configure DNS policies and block categories under Policies.' },
          { icon: '👥', title: 'Sync Students & Staff', desc: 'Import accounts from Google Workspace under Integrations.' },
          { icon: '📊', title: 'Monitor Activity',   desc: 'View browsing history, safety alerts, and reports from the dashboard.' },
        ].map(item => (
          <div key={item.title} className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <div className="text-2xl mb-2">{item.icon}</div>
            <div className="text-xs font-semibold text-slate-700 mb-1">{item.title}</div>
            <div className="text-xs text-slate-500">{item.desc}</div>
          </div>
        ))}
      </div>
      <button className="btn btn-primary px-8" onClick={onFinish}>Go to Dashboard →</button>
    </div>
  );
}

// --------------------------------------------------------------------------
// Main wizard
// --------------------------------------------------------------------------
export default function SetupWizard() {
  const [step, setStep]     = useState(1);
  const [, setSaving] = useState(false);
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();

  async function markComplete() {
    setSaving(true);
    try {
      await api.post('/settings', { setup_wizard_complete: 'true' });
      await refreshUser();
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    await markComplete();
    navigate('/admin', { replace: true });
  }

  // Redirect non-superadmins away (shouldn't normally reach this page)
  if (!user) return null;
  if (user.role !== 'superadmin') {
    navigate('/', { replace: true });
    return null;
  }

  function next() {
    if (step === 5) { finish(); return; }
    setStep(s => s + 1);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-primary-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <img src={logo} alt="ClassGuard" className="h-8 w-auto" />
          <div>
            <div className="text-base font-semibold text-slate-800">ClassGuard Setup</div>
            <div className="text-xs text-slate-400">Initial Configuration</div>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
          <StepBar current={step} />

          {step === 1 && <StepSchoolInfo   onNext={next} />}
          {step === 2 && <StepGoogleSSO    onNext={next} onSkip={next} />}
          {step === 3 && <StepHTTPS        onNext={next} onSkip={next} />}
          {step === 4 && <StepSafetyAlerts onNext={next} onSkip={next} />}
          {step === 5 && <StepDone onFinish={finish} />}
        </div>

        <p className="text-center text-xs text-slate-400 mt-4">
          You can re-run this wizard anytime from <strong>Settings → General</strong>.
        </p>
      </div>
    </div>
  );
}
