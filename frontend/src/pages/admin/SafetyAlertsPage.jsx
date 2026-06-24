import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

function Section({ title, children }) {
  return (
    <div className="card p-6 mb-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-4">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="flex items-start gap-4 py-3 border-b border-slate-50 last:border-0">
      <div className="flex-1">
        <div className="text-sm font-medium text-slate-800">{label}</div>
        {hint && <div className="text-xs text-slate-400 mt-0.5">{hint}</div>}
      </div>
      <div className="flex-shrink-0 w-64">{children}</div>
    </div>
  );
}

const KEYWORD_CATEGORIES = [
  'self_harm', 'violence', 'weapons', 'hate_speech', 'drugs_alcohol', 'adult', 'gambling', 'proxy_vpn', 'profanity', 'other',
];

function FlaggedKeywordsTab() {
  const qc = useQueryClient();
  const [newKeyword, setNewKeyword]   = useState('');
  const [newCategory, setNewCategory] = useState('profanity');

  const { data: keywords = [], isLoading } = useQuery({
    queryKey: ['content-keywords'],
    queryFn:  () => api.get('/extension/keywords/manage'),
  });

  const add = useMutation({
    mutationFn: () => api.post('/extension/keywords', { keyword: newKeyword, category: newCategory }),
    onSuccess:  () => { setNewKeyword(''); qc.invalidateQueries({ queryKey: ['content-keywords'] }); },
  });

  const toggle = useMutation({
    mutationFn: ({ id, is_active }) => api.patch(`/extension/keywords/${id}`, { is_active }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['content-keywords'] }),
  });

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/extension/keywords/${id}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['content-keywords'] }),
  });

  return (
    <Section title="Flagged Keywords">
      <p className="text-sm text-slate-600 mb-4">
        The Chrome extension scans visible page text for these terms entirely on-device (never sends page
        content to the server) — a match captures a screenshot for review. Add region- or context-specific
        terms here; this list lives only in your own database, not in the public ClassGuard source.
      </p>

      <div className="flex items-center gap-2 mb-4">
        <input
          className="input flex-1"
          placeholder="Add a keyword or short phrase…"
          value={newKeyword}
          onChange={e => setNewKeyword(e.target.value)}
        />
        <select className="input w-44" value={newCategory} onChange={e => setNewCategory(e.target.value)}>
          {KEYWORD_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          className="btn-primary"
          disabled={!newKeyword.trim() || add.isPending}
          onClick={() => add.mutate()}
        >
          Add
        </button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : keywords.length === 0 ? (
        <div className="text-slate-400 text-sm">No keywords configured yet.</div>
      ) : (
        <div className="border border-slate-100 rounded-lg divide-y divide-slate-50 max-h-80 overflow-y-auto">
          {keywords.map(k => (
            <div key={k.id} className={`flex items-center gap-3 px-3 py-2 text-sm ${!k.is_active ? 'opacity-40' : ''}`}>
              <span className="font-mono flex-1 truncate">{k.keyword}</span>
              <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{k.category}</span>
              <button
                className="text-xs text-primary-600 hover:underline w-20 text-right"
                onClick={() => toggle.mutate({ id: k.id, is_active: !k.is_active })}
              >
                {k.is_active ? 'Disable' : 'Enable'}
              </button>
              <button
                className="text-xs text-red-500 hover:underline"
                onClick={() => remove.mutate(k.id)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// Who gets notified and how — distinct from the SMTP server connection
// itself (Settings > Communications), since the mail relay is reusable
// infrastructure while "who should know about a safety event" is an
// application-level policy decision.
function AlertingTab() {
  const qc = useQueryClient();
  const [recipients, setRecipients] = useState('');
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const { data: recipientsData, isLoading: recipientsLoading } = useQuery({
    queryKey: ['safety-alert-recipients'],
    queryFn:  () => api.get('/settings/safety-alert-recipients'),
  });

  useEffect(() => {
    if (recipientsData) setRecipients(recipientsData.safety_alert_emails || '');
  }, [recipientsData]);

  const save = useMutation({
    mutationFn: () => api.put('/settings/safety-alert-recipients', { safety_alert_emails: recipients }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['safety-alert-recipients'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const sendTest = useMutation({
    mutationFn: () => api.post('/settings/safety-alerts/test'),
    onSuccess:  (res) => setTestResult({ ok: true, msg: `Sent to ${res.sentTo.join(', ')}` }),
    onError:    (err) => setTestResult({ ok: false, msg: err.message }),
  });

  return (
    <Section title="Urgent Alert Delivery">
      <p className="text-sm text-slate-600 mb-4">
        A self-harm or violence-tier flag (risk score 85+) emails this list immediately, in addition to a
        banner shown to every logged-in admin/teacher in real time. Lower-severity flags only appear in
        the Screenshots review queue. Email delivery uses the mail server configured under
        Settings &gt; Communications — set that up first if a test below fails with "SMTP not configured."
      </p>
      {recipientsLoading ? <div className="text-slate-400 text-sm">Loading…</div> : (
        <>
          <Field label="Alert Recipients" hint="Comma-separated emails — counselors, admins, whoever should know immediately">
            <input className="input" value={recipients} onChange={e => setRecipients(e.target.value)} placeholder="counselor@yourschool.org, admin@yourschool.org" />
          </Field>

          <div className="flex items-center gap-3 mt-4">
            <button className="btn-primary" onClick={() => save.mutate()}>Save</button>
            <button className="btn-secondary" disabled={sendTest.isPending} onClick={() => { setTestResult(null); sendTest.mutate(); }}>
              {sendTest.isPending ? 'Sending…' : 'Send test alert'}
            </button>
            {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
            {testResult && (
              <span className={`text-sm font-medium ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>{testResult.msg}</span>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

const TABS = ['Flagged Keywords', 'Alerting'];

export default function SafetyAlertsPage() {
  const [tab, setTab] = useState('Flagged Keywords');

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Safety Alerts</h1>
        <p className="text-slate-500 text-sm mt-0.5">Content flagging and urgent-alert delivery</p>
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-5">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors
              ${tab === t
                ? 'bg-white border border-b-white border-slate-200 text-primary-700 -mb-px'
                : 'text-slate-500 hover:text-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Flagged Keywords' && <FlaggedKeywordsTab />}
      {tab === 'Alerting' && <AlertingTab />}
    </div>
  );
}
