import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------
function Card({ title, subtitle, icon, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <div>
          <div className="font-semibold text-slate-900 text-sm">{title}</div>
          {subtitle && <div className="text-xs text-slate-500">{subtitle}</div>}
        </div>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function StatusDot({ ok }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-400' : 'bg-slate-300'}`}/>;
}

function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
      Last sync failed: {message}
    </p>
  );
}

const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}{children}
      {hint && <span className="text-[11px] text-slate-400 font-normal normal-case">{hint}</span>}
    </label>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync button
// ---------------------------------------------------------------------------
function SyncButton({ label, endpoint }) {
  const qc = useQueryClient();
  const [state, setState] = useState('idle');
  const run = async () => {
    setState('running');
    try {
      await api.post(endpoint); // server responds immediately, then syncs in the background
      setState('ok');
      // Re-check status a couple of times to pick up the real outcome
      // (success/failure + device count) once the background sync finishes.
      setTimeout(() => qc.invalidateQueries({ queryKey: ['integrations-status'] }), 2500);
      setTimeout(() => qc.invalidateQueries({ queryKey: ['integrations-status'] }), 6000);
      setTimeout(() => qc.invalidateQueries({ queryKey: ['int-devices'] }), 6000);
      setTimeout(()=>setState('idle'), 3000);
    }
    catch { setState('err'); setTimeout(()=>setState('idle'), 4000); }
  };
  return (
    <button onClick={run} disabled={state==='running'}
      className={`text-xs px-3 py-1 rounded-lg font-medium transition-colors
        ${state==='ok'  ? 'bg-green-100 text-green-700' :
          state==='err' ? 'bg-red-100 text-red-600' :
          state==='running' ? 'bg-slate-100 text-slate-400 cursor-wait' :
          'bg-primary-50 text-primary-700 hover:bg-primary-100'}`}>
      {state==='running'?'Syncing…':state==='ok'?'Synced!':state==='err'?'Failed':label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Zammad tab
// ---------------------------------------------------------------------------
function ZammadSection({ status }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ title:'', customer_email:'', description:'' });
  const [settings, setSettings] = useState({ zammad_url:'', zammad_token:'' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const configured = status?.zammad?.configured;

  const { data: tickets = [] } = useQuery({ queryKey:['tickets'], queryFn:()=>api.get('/integrations/tickets'), enabled: !!configured });

  const create = useMutation({
    mutationFn: () => api.post('/integrations/tickets', form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['tickets']}); setModal(null); },
  });

  const saveSettings = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put('/settings', settings);
      qc.invalidateQueries({queryKey:['integrations-status']});
      setModal(null);
    } catch (e) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const fmtDate = d => d ? new Date(d).toLocaleString() : '—';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <StatusDot ok={configured}/>
        <span className="text-sm text-slate-600">{configured ? 'Connected' : 'Not configured'}</span>
        <div className="ml-auto flex gap-2">
          <button onClick={()=>{setModal('settings')}} className="text-xs text-slate-500 hover:text-slate-700 underline">Settings</button>
          {configured && <SyncButton label="Sync tickets" endpoint="/integrations/sync/tickets"/>}
          {configured && <button onClick={()=>{setForm({title:'',customer_email:'',description:''});setModal('create')}} className="btn-primary text-xs">+ New Ticket</button>}
        </div>
      </div>
      <ErrorBanner message={status?.zammad?.lastError}/>
      {configured && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>{['#','Title','State','Priority','Customer','Updated'].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tickets.map(t=>(
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-400 text-xs">{t.number}</td>
                  <td className="px-3 py-2 font-medium text-slate-800 text-xs">{t.title}</td>
                  <td className="px-3 py-2 text-xs"><span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{t.state}</span></td>
                  <td className="px-3 py-2 text-xs text-slate-500">{t.priority}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{t.customer_email}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{fmtDate(t.updated_at)}</td>
                </tr>
              ))}
              {!tickets.length && <tr><td colSpan={6} className="text-center text-slate-400 py-6">No tickets synced</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {modal==='create' && (
        <Modal title="Create Zammad Ticket" onClose={()=>setModal(null)}>
          <div className="flex flex-col gap-3">
            <Field label="Title"><input className={INPUT} value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))}/></Field>
            <Field label="Customer Email"><input className={INPUT} value={form.customer_email} onChange={e=>setForm(f=>({...f,customer_email:e.target.value}))}/></Field>
            <Field label="Description"><textarea rows={4} className={INPUT} value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))}/></Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>create.mutate()} disabled={create.isPending} className="btn-primary text-sm">{create.isPending?'Creating…':'Create'}</button>
          </div>
        </Modal>
      )}
      {modal==='settings' && (
        <Modal title="Zammad Settings" onClose={()=>setModal(null)}>
          <div className="flex flex-col gap-3">
            <Field label="Zammad URL (e.g. https://support.example.com)"><input className={INPUT} value={settings.zammad_url} onChange={e=>setSettings(s=>({...s,zammad_url:e.target.value}))}/></Field>
            <Field label="API Token"><input type="password" className={INPUT} value={settings.zammad_token} onChange={e=>setSettings(s=>({...s,zammad_token:e.target.value}))}/></Field>
          </div>
          {saveError && <p className="text-red-500 text-xs mt-2">{saveError}</p>}
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={saveSettings} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Devices table (shared for Google, Mosyle, Snipe-IT)
// ---------------------------------------------------------------------------
function DevicesTable({ source, search }) {
  const [page, setPage]   = useState(1);
  const [limit, setLimit] = useState(50);

  useEffect(() => { setPage(1); }, [source, search]); // reset paging when the filter changes

  const { data: resp, isLoading } = useQuery({
    queryKey: ['int-devices', source, search, page, limit],
    queryFn: () => {
      const params = new URLSearchParams({ page, limit });
      if (source) params.set('source', source);
      if (search) params.set('search', search);
      return api.get(`/integrations/devices?${params}`);
    },
  });
  const devices = resp?.devices ?? [];
  const total   = resp?.total ?? devices.length;
  const lastPage = Math.max(1, Math.ceil(total / limit));

  const OS_COLOR = { chromeos:'blue', macos:'slate', ios:'orange', windows:'blue', android:'green', ipados:'orange' };
  const SOURCE_LABEL = { snipeit: 'Snipe-IT', mosyle: 'Mosyle', google_admin: 'Google' };
  const SOURCE_COLOR = { snipeit: 'slate', mosyle: 'orange', google_admin: 'blue' };

  if (isLoading) return <p className="text-sm text-slate-400 py-4">Loading…</p>;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Device','Model','OS','Serial','Assigned To','Sources','On Network','Status','Last Synced'].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {devices.map(d=>(
              <tr key={d.key} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-medium text-slate-800 text-xs">{d.deviceName||'—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{d.deviceModel||'—'}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium bg-${OS_COLOR[d.osType]||'slate'}-100 text-${OS_COLOR[d.osType]||'slate'}-700`}>
                    {d.osType||'—'}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{d.serialNumber||'—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{d.assignedEmail||d.assignedUser||'—'}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1 flex-wrap">
                    {d.sources.map(s => (
                      <span key={s.source} className={`px-1.5 py-0.5 rounded text-[11px] font-medium bg-${SOURCE_COLOR[s.source]||'slate'}-100 text-${SOURCE_COLOR[s.source]||'slate'}-700`}>
                        {SOURCE_LABEL[s.source] || s.source}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {d.network ? (
                    <span title={`${d.network.ip || ''} ${d.network.apName ? 'via ' + d.network.apName : ''}`}
                      className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-green-100 text-green-700">
                      Online{d.network.ip ? ` · ${d.network.ip}` : ''}
                    </span>
                  ) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 text-xs">
                  <span className={`px-2 py-0.5 rounded ${d.status==='active'||d.status==='Deployed'?'bg-green-100 text-green-700':'bg-slate-100 text-slate-500'}`}>{d.status||'—'}</span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">{d.lastSynced ? new Date(d.lastSynced).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
            {!devices.length && <tr><td colSpan={9} className="text-center text-slate-400 py-6">No devices synced yet</td></tr>}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>
            Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
          </span>
          <select value={limit} onChange={e => { setLimit(parseInt(e.target.value, 10)); setPage(1); }}
            className="border border-slate-300 rounded px-1.5 py-1 text-xs">
            {[50, 100, 200, 500].map(n => <option key={n} value={n}>{n} / page</option>)}
          </select>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="px-2 py-1 rounded border border-slate-300 disabled:opacity-40 hover:bg-slate-50">
              ← Prev
            </button>
            <span>Page {page} of {lastPage}</span>
            <button onClick={() => setPage(p => Math.min(lastPage, p + 1))} disabled={page >= lastPage}
              className="px-2 py-1 rounded border border-slate-300 disabled:opacity-40 hover:bg-slate-50">
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Google Admin devices
// ---------------------------------------------------------------------------
function GoogleSsoSection() {
  const qc = useQueryClient();
  const [form, setForm]     = useState({ google_client_id: '', google_client_secret: '', google_redirect_uri: '', google_workspace_domain: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved]   = useState(false);

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn:  () => api.get('/settings').catch(() => ({})),
  });

  useEffect(() => {
    if (appSettings) {
      setForm({
        google_client_id:        appSettings.google_client_id        || '',
        google_client_secret:    '', // write-only — never prefilled with the stored secret
        google_redirect_uri:     appSettings.google_redirect_uri     || `${window.location.origin}/auth/callback`,
        google_workspace_domain: appSettings.google_workspace_domain || '',
      });
    }
  }, [appSettings]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = { ...form };
      if (!body.google_client_secret) delete body.google_client_secret; // blank = keep current secret
      await api.put('/settings', body);
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      qc.invalidateQueries({ queryKey: ['integrations-status'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <p className="text-xs text-slate-500">
        Lets teachers and students sign in with their school Google account.{' '}
        <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="text-primary-600 underline">Google Cloud Console</a>
        {' '}→ APIs &amp; Services → Credentials → Create OAuth 2.0 Client ID (<strong>Web application</strong>).
        Add <code className="bg-slate-100 px-1 rounded font-mono text-xs">{window.location.origin}/auth/callback</code> as an Authorized redirect URI.
      </p>
      <div className="flex flex-col gap-3">
        <Field label="Google Client ID">
          <input className={INPUT} value={form.google_client_id} onChange={e=>setForm(f=>({...f, google_client_id:e.target.value}))} placeholder="123456789-xxx.apps.googleusercontent.com"/>
        </Field>
        <Field label="Google Client Secret">
          <input type="password" className={INPUT} value={form.google_client_secret} onChange={e=>setForm(f=>({...f, google_client_secret:e.target.value}))} placeholder="Leave blank to keep current secret"/>
        </Field>
        <Field label="Authorized Redirect URI">
          <input className={INPUT} value={form.google_redirect_uri} onChange={e=>setForm(f=>({...f, google_redirect_uri:e.target.value}))}/>
        </Field>
        <Field label="Allowed Domain(s) (optional)" hint="Comma-separated if your Workspace spans more than one — e.g. staff on one domain, students on a subdomain">
          <input className={INPUT} value={form.google_workspace_domain} onChange={e=>setForm(f=>({...f, google_workspace_domain:e.target.value}))} placeholder="school.org, students.school.org"/>
        </Field>
      </div>
      {saveError && <p className="text-red-500 text-xs">{saveError}</p>}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-primary text-sm w-fit">{saving ? 'Saving…' : 'Save'}</button>
        {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
      </div>
    </div>
  );
}

const ROLE_OPTIONS = ['student', 'teacher', 'admin'];

// Lets an admin decide which role new users get based on their Google OU,
// instead of every synced/SSO-created account defaulting to 'student' (which
// silently locked every staff member out of the admin app — RequireAuth
// needs at least 'teacher'). Longest-matching-OU-prefix wins; an explicit
// manual role change via the Users page is never overwritten by this.
function OuRoleRulesSection() {
  const qc = useQueryClient();
  const [rules, setRules]   = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved]   = useState(false);
  const [backfillResult, setBackfillResult] = useState(null);
  const [backfilling, setBackfilling] = useState(false);

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn:  () => api.get('/settings').catch(() => ({})),
  });
  const { data: ouList = [] } = useQuery({
    queryKey: ['ou-list'],
    queryFn:  () => api.get('/policies/ou-list'),
  });
  const { data: ouPreview = [] } = useQuery({
    queryKey: ['ou-role-preview'],
    queryFn:  () => api.get('/integrations/google/ou-role-preview'),
  });

  useEffect(() => {
    if (!appSettings) return;
    if (appSettings.google_ou_role_rules) {
      try { setRules(JSON.parse(appSettings.google_ou_role_rules)); }
      catch { setRules([]); }
    } else {
      setRules([{ ouPrefix: '/Students', role: 'student' }, { ouPrefix: '/Employees', role: 'teacher' }]);
    }
  }, [appSettings]);

  const updateRule = (i, field, value) =>
    setRules(rs => rs.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
  const removeRule = (i) => setRules(rs => rs.filter((_, idx) => idx !== i));
  const addRule = (prefill = {}) => setRules(rs => [...rs, { ouPrefix: '', role: 'teacher', ...prefill }]);

  const coveredPrefixes = rules.map(r => r.ouPrefix);
  const uncovered = ouPreview.filter(p => !coveredPrefixes.some(prefix => p.ou === prefix || p.ou.startsWith(prefix.replace(/\/$/, '') + '/')));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const clean = rules.filter(r => r.ouPrefix?.trim()).map(r => ({ ouPrefix: r.ouPrefix.trim(), role: r.role }));
      await api.put('/settings', { google_ou_role_rules: JSON.stringify(clean) });
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const backfill = async () => {
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const result = await api.post('/integrations/google/backfill-roles');
      setBackfillResult(result);
      qc.invalidateQueries({ queryKey: ['users-list'] });
    } catch (e) {
      setBackfillResult({ error: e.message || 'Backfill failed' });
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="border border-slate-200 rounded-lg p-3 flex flex-col gap-3">
      <div>
        <span className="text-sm font-medium text-slate-700">Role Mapping by OU</span>
        <p className="text-xs text-slate-500 mt-0.5">
          New users from directory sync or first Google sign-in are given a role based on the longest
          matching OU prefix below (falls back to "student" if nothing matches). Roles changed manually
          on the Users page are never overwritten by this.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {rules.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className={INPUT + ' flex-1'} list="ou-role-datalist" placeholder="/Employees"
              value={r.ouPrefix} onChange={e => updateRule(i, 'ouPrefix', e.target.value)}/>
            <select className={INPUT + ' w-32'} value={r.role} onChange={e => updateRule(i, 'role', e.target.value)}>
              {ROLE_OPTIONS.map(role => <option key={role} value={role}>{role}</option>)}
            </select>
            <button onClick={() => removeRule(i)} className="text-slate-400 hover:text-red-500 text-xs px-1">✕</button>
          </div>
        ))}
        <datalist id="ou-role-datalist">
          {ouList.map(p => <option key={p} value={p}/>)}
        </datalist>
        <button onClick={() => addRule()} className="text-xs text-primary-600 hover:text-primary-700 underline w-fit">+ Add rule</button>
      </div>

      {saveError && <p className="text-red-500 text-xs">{saveError}</p>}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-secondary text-sm w-fit">{saving ? 'Saving…' : 'Save Rules'}</button>
        {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
        <button onClick={backfill} disabled={backfilling} className="text-xs text-slate-500 hover:text-slate-700 underline ml-auto">
          {backfilling ? 'Applying…' : 'Re-apply to existing users now'}
        </button>
      </div>
      {backfillResult && (
        backfillResult.error
          ? <p className="text-red-500 text-xs">{backfillResult.error}</p>
          : <p className="text-xs text-slate-500">Checked {backfillResult.checked} users, updated {backfillResult.changed}.</p>
      )}

      {uncovered.length > 0 && (
        <div className="border-t border-slate-200 pt-3 mt-1">
          <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1">
            {uncovered.length} OU{uncovered.length === 1 ? '' : 's'} not covered by a rule above (falling back to "student")
          </p>
          <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {uncovered.map(p => (
              <div key={p.ou} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="font-mono text-slate-700">{p.ou}</span>
                <span className="text-slate-400">{p.count} user{p.count === 1 ? '' : 's'}, currently {p.currentRole}</span>
                <button onClick={() => addRule({ ouPrefix: p.ou })}
                  className="ml-auto text-primary-600 hover:text-primary-700 underline whitespace-nowrap">
                  + Add rule for this OU
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GoogleSyncSection({ status }) {
  const qc = useQueryClient();
  const configured = status?.google?.configured;
  const [form, setForm]     = useState({ google_service_account_json: '', google_superadmin_email: '', google_customer_id: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved]   = useState(false);

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn:  () => api.get('/settings').catch(() => ({})),
  });

  useEffect(() => {
    if (appSettings) {
      setForm({
        google_service_account_json: '', // write-only — never prefilled with the stored key
        google_superadmin_email:     appSettings.google_superadmin_email || '',
        google_customer_id:          appSettings.google_customer_id      || '',
      });
    }
  }, [appSettings]);

  const hasStoredKey = !!appSettings?.google_service_account_json;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = { ...form };
      if (!body.google_service_account_json) delete body.google_service_account_json; // blank = keep current key
      await api.put('/settings', body);
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      qc.invalidateQueries({ queryKey: ['integrations-status'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <StatusDot ok={configured}/>
        <span className="text-sm text-slate-600">{configured ? 'Service account configured' : 'Not configured — Chromebooks/users/groups will not sync'}</span>
      </div>

      {/* Directory and device sync are independent operations — one can fail
          while the other succeeds, so they're tracked and shown separately. */}
      <div className="border border-slate-200 rounded-lg p-3 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-slate-700">Users / Groups / Org Units</span>
          {status?.google?.lastSync && <span className="text-xs text-slate-400">Last sync: {new Date(status.google.lastSync).toLocaleString()}</span>}
          {configured && <div className="ml-auto"><SyncButton label="Sync users/groups" endpoint="/integrations/sync/google"/></div>}
        </div>
        <ErrorBanner message={status?.google?.lastError}/>
      </div>

      <div className="border border-slate-200 rounded-lg p-3 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-slate-700">Chromebook Devices</span>
          {status?.googleDevices?.deviceCount !== undefined && (
            <span className="text-xs text-slate-400">{status.googleDevices.deviceCount} devices</span>
          )}
          {status?.googleDevices?.lastSync && <span className="text-xs text-slate-400">Last sync: {new Date(status.googleDevices.lastSync).toLocaleString()}</span>}
          {configured && <div className="ml-auto"><SyncButton label="Sync devices" endpoint="/integrations/sync/google-devices"/></div>}
        </div>
        <ErrorBanner message={status?.googleDevices?.lastError}/>
      </div>

      {configured && <OuRoleRulesSection/>}

      <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-700">
        This is a separate credential from both Google Workspace Login (SSO) and the Chrome Extension's OAuth
        client — pulling in Chromebooks, users, and groups needs a <strong>service account</strong> with
        domain-wide delegation, since it reads the Admin Directory on the district's behalf rather than acting
        as a single signed-in user.
      </div>

      <ol className="text-xs text-slate-600 space-y-1.5 list-decimal list-inside max-w-2xl">
        <li>
          <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noreferrer" className="text-primary-600 underline">
            Google Cloud Console
          </a> → IAM &amp; Admin → Service Accounts → Create Service Account.
        </li>
        <li>Open it → Keys → Add Key → Create new key → <strong>JSON</strong> → download it, then paste its full contents below.</li>
        <li>
          Copy the service account's <strong>numeric Client ID</strong> (on the same Details page, not its email address).
        </li>
        <li>
          In Google Workspace Admin Console → Security → Access and data control → API controls → Domain-wide
          delegation → Add new → paste that numeric Client ID with these scopes:
          <pre className="bg-slate-800 text-green-300 text-xs rounded p-2 mt-1 leading-5 overflow-auto">{`https://www.googleapis.com/auth/admin.directory.user.readonly
https://www.googleapis.com/auth/admin.directory.group.readonly
https://www.googleapis.com/auth/admin.directory.orgunit.readonly
https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly`}</pre>
        </li>
        <li>Set the Superadmin Email below to a Workspace super-admin address — the service account impersonates them to call the Admin SDK.</li>
      </ol>

      <div className="flex flex-col gap-3 max-w-xl">
        <Field label={`Service Account JSON Key${hasStoredKey ? ' (one is already saved)' : ''}`}>
          <textarea
            rows={6}
            className={`${INPUT} font-mono text-xs`}
            value={form.google_service_account_json}
            onChange={e=>setForm(f=>({...f, google_service_account_json:e.target.value}))}
            placeholder={hasStoredKey ? 'Leave blank to keep the currently saved key' : 'Paste the full downloaded JSON key file contents'}
          />
        </Field>
        <Field label="Superadmin Email">
          <input className={INPUT} value={form.google_superadmin_email} onChange={e=>setForm(f=>({...f, google_superadmin_email:e.target.value}))} placeholder="admin@school.org"/>
        </Field>
        <Field label="Customer ID (optional)">
          <input className={INPUT} value={form.google_customer_id} onChange={e=>setForm(f=>({...f, google_customer_id:e.target.value}))} placeholder="Leave blank for my_customer"/>
        </Field>
      </div>
      {saveError && <p className="text-red-500 text-xs">{saveError}</p>}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-primary text-sm w-fit">{saving ? 'Saving…' : 'Save'}</button>
        {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
      </div>

      {configured && <DevicesTable source="google_admin"/>}
    </div>
  );
}

function YoutubeApiSection() {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved]   = useState(false);

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn:  () => api.get('/settings').catch(() => ({})),
  });

  useEffect(() => {
    if (appSettings) setApiKey(appSettings.youtube_api_key || '');
  }, [appSettings]);

  const save = async () => {
    await api.put('/settings', { youtube_api_key: apiKey });
    qc.invalidateQueries({ queryKey: ['app-settings'] });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <p className="text-xs text-slate-500">
        Required for per-category and per-video YouTube filtering in policy rules. The API key is stored
        server-side and never sent to student devices. Video category lookups are cached 24 hours in Redis —
        10,000 free quota units/day covers a large school with heavy YouTube use.
      </p>
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700">
        <strong>Setup:</strong>{' '}
        <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer" className="underline">Google Cloud Console</a>
        {' '}→ APIs &amp; Services → Library → search <em>YouTube Data API v3</em> → Enable →
        Credentials → Create API Key. Restrict the key to YouTube Data API v3 only.
      </div>
      <Field label="YouTube Data API Key">
        <input type="password" className={`${INPUT} font-mono`} value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="AIzaSy…"/>
      </Field>
      <div className="flex items-center gap-3">
        <button onClick={save} className="btn-primary text-sm w-fit">Save API Key</button>
        {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
      </div>
    </div>
  );
}

const GOOGLE_SUBTABS = ['Device & Directory Sync', 'SSO Login', 'Chrome Extension', 'YouTube Data API'];

function GoogleWorkspaceTab({ status }) {
  const [subtab, setSubtab] = useState('Device & Directory Sync');
  return (
    <div>
      <div className="flex gap-1 border-b border-slate-100 mb-5">
        {GOOGLE_SUBTABS.map(t => (
          <button key={t} onClick={() => setSubtab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-lg whitespace-nowrap transition-colors
              ${subtab === t ? 'bg-slate-50 border border-b-slate-50 border-slate-200 text-primary-700 -mb-px' : 'text-slate-500 hover:text-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>
      {subtab === 'Device & Directory Sync' && <GoogleSyncSection status={status}/>}
      {subtab === 'SSO Login'               && <GoogleSsoSection/>}
      {subtab === 'Chrome Extension'        && <ExtensionSection/>}
      {subtab === 'YouTube Data API'        && <YoutubeApiSection/>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome Extension
// ---------------------------------------------------------------------------
function ExtensionDownloadStatus() {
  const [status, setStatus] = useState('checking'); // checking | ready | missing
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    fetch('/downloads/classguard-extension.zip', { method: 'HEAD' })
      .then((res) => {
        if (!res.ok) { setStatus('missing'); return; }
        setMeta({
          size:         res.headers.get('content-length'),
          lastModified: res.headers.get('last-modified'),
        });
        setStatus('ready');
      })
      .catch(() => setStatus('missing'));
  }, []);

  if (status === 'checking') {
    return <p className="text-xs text-slate-400">Checking for a built extension package…</p>;
  }

  if (status === 'missing') {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800">
        No build found yet. Set the <strong>OAuth Client ID</strong> above — the builder rebuilds automatically
        within about a minute of saving. (A code/version change, rather than a config change, still needs a
        manual image rebuild on the host:{' '}
        <code className="font-mono">docker compose build extension-builder &amp;&amp; docker compose up -d extension-builder</code>.)
      </div>
    );
  }

  const sizeMb = meta?.size ? (Number(meta.size) / (1024 * 1024)).toFixed(1) : null;
  return (
    <div className="flex items-center gap-3">
      <a
        href="/downloads/classguard-extension.crx"
        download
        className="inline-flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium px-4 py-2 rounded-lg"
      >
        Download Extension (.crx)
      </a>
      <a
        href="/downloads/classguard-extension.zip"
        download
        className="inline-flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg"
      >
        Unpacked (.zip, for dev-mode sideloading)
      </a>
      <span className="text-xs text-slate-400">
        {sizeMb && `${sizeMb} MB`}{meta?.lastModified && ` · built ${new Date(meta.lastModified).toLocaleString()}`}
      </span>
    </div>
  );
}

function ExtensionIdentity({ serverUrl, onExtensionId }) {
  const [status, setStatus]         = useState('checking'); // checking | ready | missing
  const [extensionId, setExtensionId] = useState(null);
  const [copied, setCopied]         = useState('');

  useEffect(() => {
    fetch('/downloads/extension-id.txt')
      .then((res) => {
        if (!res.ok) { setStatus('missing'); return null; }
        return res.text();
      })
      .then((text) => {
        if (text == null) return;
        setExtensionId(text.trim());
        onExtensionId?.(text.trim());
        setStatus('ready');
      })
      .catch(() => setStatus('missing'));
  }, []);

  const updateUrl = `${serverUrl}/downloads/update.xml`;

  const copy = (key, text) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 2000);
  };

  if (status === 'checking') return null;

  if (status === 'missing') {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800 mb-3">
        No signed build found yet — auto-update requires a one-time signing key. On the host, run:
        <pre className="bg-slate-800 text-green-300 rounded p-2 mt-2 font-mono leading-5">docker compose run --rm extension-builder node scripts/generate-key.js</pre>
        then add the printed <code className="font-mono">EXTENSION_SIGNING_KEY</code> line to <code className="font-mono">.env</code> on every node
        in this cluster, and recreate <code className="font-mono">extension-builder</code>.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
      <div>
        <div className="text-xs font-medium text-slate-500 mb-1">Extension ID</div>
        <div className="flex items-center gap-1.5">
          <code className="bg-slate-100 rounded px-2 py-1 text-xs font-mono flex-1 truncate">{extensionId}</code>
          <button onClick={() => copy('id', extensionId)} className="text-xs bg-slate-600 hover:bg-slate-500 text-white px-2 py-1 rounded flex-shrink-0">
            {copied === 'id' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
      <div>
        <div className="text-xs font-medium text-slate-500 mb-1">Update URL</div>
        <div className="flex items-center gap-1.5">
          <code className="bg-slate-100 rounded px-2 py-1 text-xs font-mono flex-1 truncate">{updateUrl}</code>
          <button onClick={() => copy('update', updateUrl)} className="text-xs bg-slate-600 hover:bg-slate-500 text-white px-2 py-1 rounded flex-shrink-0">
            {copied === 'update' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExtensionOAuthSection({ extensionId }) {
  const qc = useQueryClient();
  const [modal, setModal]   = useState(false);
  const [form, setForm]     = useState({ extension_oauth_client_id: '', extension_public_url: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn:  () => api.get('/settings').catch(() => ({})),
  });

  const configured = !!appSettings?.extension_oauth_client_id;

  const openModal = () => {
    setForm({
      extension_oauth_client_id: appSettings?.extension_oauth_client_id || '',
      extension_public_url:      appSettings?.extension_public_url     || '',
    });
    setSaveError(null);
    setModal(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put('/settings', form);
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      setModal(null);
    } catch (e) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <StatusDot ok={configured}/>
        <span className="text-sm text-slate-600">
          {configured ? 'Configured — rebuilds automatically when changed' : 'Not configured — the extension cannot install on any device until this is set'}
        </span>
        <button onClick={openModal} className="ml-auto text-xs text-slate-500 hover:text-slate-700 underline">Settings</button>
      </div>
      <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-700">
        This is a <strong>different</strong> OAuth client than the one under the Google Workspace tab — that one is
        for admin/teacher login on the web app ("Web application" type). This one is required for the extension's{' '}
        <code className="font-mono">chrome.identity</code> Google sign-in and must be type{' '}
        <strong>Chrome Extension</strong>. Chrome silently rejects the entire extension package — no install, no
        error shown anywhere — if this is left blank.
      </div>

      {modal && (
        <Modal title="Chrome Extension OAuth Client ID" onClose={()=>setModal(null)}>
          <ol className="text-xs text-slate-600 mb-4 space-y-1.5 list-decimal list-inside">
            <li>
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="text-primary-600 underline">
                Google Cloud Console
              </a> → APIs &amp; Services → Credentials → Create Credentials → OAuth client ID.
            </li>
            <li>Application type: <strong>Chrome Extension</strong> (not Web application).</li>
            <li>Item ID: <code className="bg-slate-100 px-1 rounded font-mono">{extensionId || '(see Extension ID below, once a build exists)'}</code></li>
            <li>Copy the resulting Client ID and paste it below.</li>
          </ol>
          <div className="flex flex-col gap-3">
            <Field label="Extension OAuth Client ID">
              <input className={INPUT} value={form.extension_oauth_client_id}
                onChange={e=>setForm(f=>({...f, extension_oauth_client_id:e.target.value}))}
                placeholder="123456789-yyy.apps.googleusercontent.com"/>
            </Field>
            <Field label="Public URL override (optional)">
              <input className={INPUT} value={form.extension_public_url}
                onChange={e=>setForm(f=>({...f, extension_public_url:e.target.value}))}
                placeholder="Leave blank to use the active TLS domain"/>
            </Field>
          </div>
          {saveError && <p className="text-red-500 text-xs mt-2">{saveError}</p>}
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ExtensionSection() {
  const [copied, setCopied] = useState('');
  const [extensionId, setExtensionId] = useState(null);
  const serverUrl = window.location.origin;
  const policy = JSON.stringify({ serverUrl }, null, 2);

  const copy = (key, text) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 2000);
  };

  return (
    <div className="space-y-5">
      <Card title="OAuth Client ID" icon="🔑" subtitle="Required before the extension can install on any device">
        <ExtensionOAuthSection extensionId={extensionId} />
      </Card>

      <Card title="Deploy to Google Admin Console" icon="🧩" subtitle="One-time setup per district">
        <div className="space-y-5">
          <div>
            <div className="text-sm font-semibold text-slate-700 mb-1">Step 1 — Get the extension's identity</div>
            <p className="text-xs text-slate-500 mb-3">
              Signed with a permanent key, so Chrome treats this as the same extension forever, even as the code
              inside it changes. Copy the Extension ID and Update URL below.
            </p>
            <ExtensionIdentity serverUrl={serverUrl} onExtensionId={setExtensionId} />
            <ExtensionDownloadStatus />
          </div>

          <div>
            <div className="text-sm font-semibold text-slate-700 mb-1">Step 2 — Add it as a custom extension in Google Admin Console</div>
            <p className="text-xs text-slate-500 mb-2">
              Google Admin → Devices → Chrome → Apps &amp; Extensions → select your student OU → Add (+) → Add Chrome app or
              extension by ID. Paste the Extension ID, then choose <strong>"From a custom URL"</strong> and paste the Update URL.
            </p>
          </div>

          <div>
            <div className="text-sm font-semibold text-slate-700 mb-1">Step 3 — Force-install and set managed storage</div>
            <p className="text-xs text-slate-500 mb-2">
              Set the install policy to <strong>Force install</strong>. In the same screen's Policy for extensions (JSON), paste:
            </p>
            <div className="relative">
              <pre className="bg-slate-800 text-green-300 text-xs rounded p-3 overflow-auto leading-5">{policy}</pre>
              <button
                onClick={() => copy('policy', policy)}
                className="absolute top-2 right-2 text-xs bg-slate-600 hover:bg-slate-500 text-white px-2 py-1 rounded"
              >
                {copied === 'policy' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              The extension reads <code className="font-mono">chrome.storage.managed</code> at runtime to discover the
              server URL, so you never need to rebuild it just because the address changes.
            </p>
          </div>

          <div>
            <div className="text-sm font-semibold text-slate-700 mb-1">Step 4 — Pre-authorize sign-in so students can't decline it</div>
            <p className="text-xs text-slate-500 mb-2">
              Without this, the extension's first run shows a Google "Allow access" consent prompt — and a
              student who clicks <strong>Deny</strong> blocks monitoring/policy enforcement on that device entirely
              until they accept (the extension retries every minute, but it can't force a click). Pre-authorizing
              skips the prompt completely: Chrome grants access silently because the domain already consented on
              the student's behalf.
            </p>
            <ol className="text-xs text-slate-500 space-y-1.5 list-decimal list-inside">
              <li>
                Google Workspace Admin Console → Security → Access and data control → API controls →{' '}
                <strong>Manage third-party app access</strong>.
              </li>
              <li>Add app → search by <strong>OAuth Client ID</strong> → paste the Chrome Extension OAuth Client ID from the section above.</li>
              <li>Select it, choose scopes <code className="font-mono">openid</code>, <code className="font-mono">email</code>, <code className="font-mono">profile</code>, and set access to <strong>Trusted</strong>.</li>
              <li>Apply it to the same OU the extension is force-installed in.</li>
            </ol>
          </div>

          <div className="bg-green-50 border border-green-200 rounded p-3 text-xs text-green-800">
            <strong>Future code updates:</strong> bump the version in <code className="font-mono">chrome-extension/package.json</code>,
            then on every node: <code className="font-mono">docker compose build extension-builder &amp;&amp; docker compose up -d extension-builder</code>.
            Chrome checks the Update URL on its own schedule and installs automatically — no re-upload, no re-pasting the policy.
            Config-only changes (the OAuth Client ID above, or the public URL) rebuild on their own within about a minute.
          </div>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mosyle
// ---------------------------------------------------------------------------
function MosyleSection({ status }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ mosyle_access_token: '', mosyle_email: '', mosyle_password: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const configured = status?.mosyle?.configured;

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn:  () => api.get('/settings').catch(() => ({})),
  });

  const openModal = () => {
    setForm({
      mosyle_access_token: '', // write-only — never prefilled
      mosyle_email:         appSettings?.mosyle_email || '',
      mosyle_password:      '', // write-only — never prefilled
    });
    setSaveError(null);
    setModal(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = { ...form };
      if (!body.mosyle_access_token) delete body.mosyle_access_token; // blank = keep current
      if (!body.mosyle_password)     delete body.mosyle_password;     // blank = keep current
      await api.put('/settings', body);
      qc.invalidateQueries({queryKey:['integrations-status']});
      qc.invalidateQueries({queryKey:['app-settings']});
      setModal(null);
    } catch (e) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <StatusDot ok={configured}/>
        <span className="text-sm text-slate-600">{configured ? 'Connected' : 'Not configured'}</span>
        <div className="ml-auto flex gap-2">
          <button onClick={openModal} className="text-xs text-slate-500 hover:text-slate-700 underline">Settings</button>
          {configured && <SyncButton label="Sync Apple devices" endpoint="/integrations/sync/mosyle"/>}
        </div>
      </div>
      <ErrorBanner message={status?.mosyle?.lastError}/>
      {configured && <DevicesTable source="mosyle"/>}
      {modal && (
        <Modal title="Mosyle Settings" onClose={()=>setModal(null)}>
          <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-700 mb-3">
            Mosyle Manager's token-only auth is deprecated — an admin email/password is required too,
            so we can trade them for a 24h session token automatically (re-logging in as needed). A
            dedicated API-only admin account in Mosyle, rather than your personal login, is recommended.
          </div>
          <div className="flex flex-col gap-3">
            <Field label="Access Token" hint="From My School/Organization → API Integration">
              <input type="password" className={INPUT} value={form.mosyle_access_token}
                onChange={e=>setForm(f=>({...f, mosyle_access_token:e.target.value}))}
                placeholder="Leave blank to keep the currently saved token"/>
            </Field>
            <Field label="Admin Email">
              <input className={INPUT} value={form.mosyle_email}
                onChange={e=>setForm(f=>({...f, mosyle_email:e.target.value}))}/>
            </Field>
            <Field label="Admin Password">
              <input type="password" className={INPUT} value={form.mosyle_password}
                onChange={e=>setForm(f=>({...f, mosyle_password:e.target.value}))}
                placeholder="Leave blank to keep the currently saved password"/>
            </Field>
          </div>
          {saveError && <p className="text-red-500 text-xs mt-2">{saveError}</p>}
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snipe-IT
// ---------------------------------------------------------------------------
function SnipeitSection({ status }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ snipeit_url:'', snipeit_token:'', snipeit_client_id:'', snipeit_client_secret:'' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const configured = status?.snipeit?.configured;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put('/settings', form);
      qc.invalidateQueries({queryKey:['integrations-status']});
      setModal(null);
    } catch (e) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <StatusDot ok={configured}/>
        <span className="text-sm text-slate-600">{configured ? 'Connected' : 'Not configured'}</span>
        <div className="ml-auto flex gap-2">
          <button onClick={()=>setModal(true)} className="text-xs text-slate-500 hover:text-slate-700 underline">Settings</button>
          {configured && <SyncButton label="Sync inventory" endpoint="/integrations/sync/snipeit"/>}
        </div>
      </div>
      <ErrorBanner message={status?.snipeit?.lastError}/>
      {configured && <DevicesTable source="snipeit"/>}
      {modal && (
        <Modal title="Snipe-IT Settings" onClose={()=>setModal(null)}>
          <div className="flex flex-col gap-3">
            <Field label="Snipe-IT URL"><input className={INPUT} value={form.snipeit_url} onChange={e=>setForm(f=>({...f,snipeit_url:e.target.value}))}/></Field>
            <Field label="Personal Access Token">
              <input type="password" className={INPUT} value={form.snipeit_token} onChange={e=>setForm(f=>({...f,snipeit_token:e.target.value}))}/>
              <span className="text-[11px] text-slate-400 font-normal normal-case">From your account menu → Manage API Keys → Create New Token (a long JWT)</span>
            </Field>
            <div className="border-t border-slate-200 pt-3 mt-1">
              <p className="text-xs font-semibold text-slate-500 uppercase mb-2">
                Or, if your instance only lets you create an OAuth Client
              </p>
              <div className="flex flex-col gap-3">
                <Field label="OAuth Client ID"><input className={INPUT} value={form.snipeit_client_id} onChange={e=>setForm(f=>({...f,snipeit_client_id:e.target.value}))}/></Field>
                <Field label="OAuth Client Secret"><input type="password" className={INPUT} value={form.snipeit_client_secret} onChange={e=>setForm(f=>({...f,snipeit_client_secret:e.target.value}))}/></Field>
              </div>
            </div>
          </div>
          {saveError && <p className="text-red-500 text-xs mt-2">{saveError}</p>}
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PHPiPAM migration wizard
// ---------------------------------------------------------------------------
function PhpipamSection() {
  const [step, setStep]     = useState('config');
  const [log, setLog]       = useState([]);
  const [running, setRunning] = useState(false);
  const [form, setForm]     = useState({
    phpipam_url:'', phpipam_app_id:'', phpipam_username:'', phpipam_password:'',
    phpipam_verify_ssl:'true', phpipam_auth_mode:'user_token', phpipam_app_code:'',
  });

  const test = async () => {
    try {
      await api.put('/settings', form);
      const res = await api.post('/integrations/phpipam/test');
      alert(res.message || 'Connection successful');
    } catch(e) { alert('Failed: ' + (e.message || 'unknown')); }
  };

  const run = async () => {
    setRunning(true);
    setLog(['Starting migration…']);
    setStep('log');
    await api.put('/settings', form);
    try {
      await api.post('/integrations/phpipam/import');
      setLog(l=>[...l, 'Migration triggered — check server logs for progress.']);
    } catch(e) {
      setLog(l=>[...l, 'Error: ' + e.message]);
    }
    setRunning(false);
  };

  if (step==='log') return (
    <div>
      <div className="bg-slate-900 text-green-400 font-mono text-xs rounded-lg p-4 h-40 overflow-y-auto">
        {log.map((l,i)=><div key={i}>{l}</div>)}
      </div>
      <p className="text-xs text-slate-500 mt-2">The import runs in the background on the server. You can leave this page.</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-600">Import sections, VRFs, VLANs, subnets, and IP assignments from PHPiPAM.</p>
      {[['PHPiPAM URL','phpipam_url','url'],['App ID','phpipam_app_id','text']].map(([l,k,t])=>(
        <Field key={k} label={l}><input type={t} className={INPUT} value={form[k]} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))}/></Field>
      ))}
      <Field label="Auth Method" hint="Must match the App security mode set for this app in PHPiPAM (Administration → API)">
        <select className={INPUT} value={form.phpipam_auth_mode}
          onChange={e=>setForm(f=>({...f,phpipam_auth_mode:e.target.value}))}>
          <option value="user_token">User token (username + password)</option>
          <option value="app_code">App code (static token)</option>
        </select>
      </Field>
      {form.phpipam_auth_mode === 'app_code' ? (
        <Field label="App Code" hint="The App Code shown for this app in PHPiPAM, not your account password">
          <input type="password" className={INPUT} value={form.phpipam_app_code}
            onChange={e=>setForm(f=>({...f,phpipam_app_code:e.target.value}))}/>
        </Field>
      ) : (
        <>
          <Field label="Username"><input className={INPUT} value={form.phpipam_username} onChange={e=>setForm(f=>({...f,phpipam_username:e.target.value}))}/></Field>
          <Field label="Password"><input type="password" className={INPUT} value={form.phpipam_password} onChange={e=>setForm(f=>({...f,phpipam_password:e.target.value}))}/></Field>
        </>
      )}
      <Field label="Verify SSL certificate" hint="Turn off if your PHPiPAM uses a self-signed cert on the LAN">
        <input type="checkbox" checked={form.phpipam_verify_ssl==='true'}
          onChange={e=>setForm(f=>({...f,phpipam_verify_ssl: e.target.checked ? 'true' : 'false'}))}/>
      </Field>
      <div className="flex gap-2 mt-2">
        <button onClick={test} className="btn-secondary text-sm">Test Connection</button>
        <button onClick={run} disabled={running} className="btn-primary text-sm">Start Import</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// All-devices view
// ---------------------------------------------------------------------------
function AllDevicesTab() {
  const [sourceFilter, setSourceFilter] = useState('');
  const [search, setSearch] = useState('');

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-slate-500">
        One row per physical device — the same Chromebook or iPad showing up in both Snipe-IT and an MDM
        is merged here, matched by serial number, with live "on network" status overlaid from UniFi by MAC.
        Filtering by source shows devices that have a record there, still with data from every other source too.
      </p>
      <div className="flex items-center gap-3">
        <select value={sourceFilter} onChange={e=>setSourceFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500">
          <option value="">All sources</option>
          <option value="google_admin">Google Admin</option>
          <option value="mosyle">Mosyle</option>
          <option value="snipeit">Snipe-IT</option>
        </select>
        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search name, serial, or assigned user…"
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm flex-1 max-w-sm focus:outline-none focus:ring-1 focus:ring-primary-500"/>
      </div>
      <DevicesTable source={sourceFilter||null} search={search||null}/>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = ['Overview','All Devices','Google Workspace','Mosyle','Snipe-IT','Zammad','PHPiPAM Migration'];

export default function IntegrationsPage() {
  const [tab, setTab] = useState('Overview');

  const { data: status = {} } = useQuery({
    queryKey: ['integrations-status'],
    queryFn:  () => api.get('/integrations/status'),
    refetchInterval: 30_000,
  });

  const integrations = [
    { id:'google',   label:'Google Workspace', icon:'🔵', status },
    { id:'mosyle',   label:'Mosyle MDM',        icon:'🍎', status },
    { id:'snipeit',  label:'Snipe-IT',          icon:'📦', status },
    { id:'zammad',   label:'Zammad Help Desk',  icon:'🎫', status },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">Integrations</h1>
        <p className="text-slate-500 text-sm mt-0.5">Connect external systems — MDM, helpdesk, inventory, and IP management</p>
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-5 overflow-x-auto">
        {TABS.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg whitespace-nowrap transition-colors
              ${tab===t ? 'bg-white border border-b-white border-slate-200 text-primary-700 -mb-px' : 'text-slate-500 hover:text-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab==='Overview' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {integrations.map(i=>{
            // Google tracks directory sync (users/groups/OUs) and Chromebook
            // device sync as two independent operations — merge them for this
            // summary card; the Google Workspace tab shows them separately.
            const s = i.id === 'google'
              ? {
                  configured: status.google?.configured,
                  lastSync:   status.google?.lastSync || status.googleDevices?.lastSync,
                  lastError:  status.google?.lastError || status.googleDevices?.lastError,
                  deviceCount: status.googleDevices?.deviceCount,
                }
              : status[i.id];
            return (
              <Card key={i.id} title={i.label} icon={i.icon}
                subtitle={s?.lastSync ? `Last sync: ${new Date(s.lastSync).toLocaleString()}` : 'Never synced'}>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <StatusDot ok={s?.configured && !s?.lastError}/>
                    <span className="text-sm text-slate-600">
                      {!s?.configured ? 'Not configured' : s?.lastError ? 'Sync failing' : 'Configured'}
                    </span>
                    {s?.deviceCount !== undefined && (
                      <span className="ml-auto text-xs text-slate-400">{s.deviceCount} devices</span>
                    )}
                  </div>
                  <ErrorBanner message={s?.lastError}/>
                </div>
              </Card>
            );
          })}
          <Card title="PHPiPAM Migration" icon="🔄" subtitle="One-time import from your existing PHPiPAM instance">
            <p className="text-sm text-slate-600">Import IP address database, subnets, and VLANs into ClassGuard IPAM.</p>
          </Card>
        </div>
      )}

      {tab==='All Devices'        && <AllDevicesTab/>}
      {tab==='Google Workspace'   && <GoogleWorkspaceTab status={status}/>}
      {tab==='Mosyle'             && <MosyleSection status={status}/>}
      {tab==='Snipe-IT'           && <SnipeitSection status={status}/>}
      {tab==='Zammad'             && <ZammadSection status={status}/>}
      {tab==='PHPiPAM Migration'  && <PhpipamSection/>}
    </div>
  );
}
