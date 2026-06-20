import { useState, useCallback } from 'react';
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

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}{children}
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
  const configured = status?.zammad?.configured;

  const { data: tickets = [] } = useQuery({ queryKey:['tickets'], queryFn:()=>api.get('/integrations/tickets'), enabled: !!configured });

  const create = useMutation({
    mutationFn: () => api.post('/integrations/tickets', form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['tickets']}); setModal(null); },
  });

  const saveSettings = async () => {
    await api.put('/settings', settings);
    qc.invalidateQueries({queryKey:['integrations-status']});
    setModal(null);
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
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={saveSettings} className="btn-primary text-sm">Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Devices table (shared for Google, Mosyle, Snipe-IT)
// ---------------------------------------------------------------------------
function DevicesTable({ source }) {
  const { data: resp, isLoading } = useQuery({
    queryKey: ['int-devices', source],
    queryFn: () => api.get(`/integrations/devices${source ? `?source=${source}` : ''}`),
  });
  const devices = resp?.devices ?? resp ?? [];

  const OS_COLOR = { chromeos:'blue', macos:'slate', ios:'orange', windows:'blue', android:'green' };

  if (isLoading) return <p className="text-sm text-slate-400 py-4">Loading…</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
          <tr>{['Device','Model','OS','Serial','Assigned To','IP','Status','Last Seen'].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {devices.map(d=>(
            <tr key={d.id} className="hover:bg-slate-50">
              <td className="px-3 py-2 font-medium text-slate-800 text-xs">{d.device_name||'—'}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{d.device_model||'—'}</td>
              <td className="px-3 py-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium bg-${OS_COLOR[d.os_type]||'slate'}-100 text-${OS_COLOR[d.os_type]||'slate'}-700`}>
                  {d.os_type||'—'}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-xs text-slate-500">{d.serial_number||'—'}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{d.assigned_email||'—'}</td>
              <td className="px-3 py-2 font-mono text-xs text-slate-500">{(d.ip_addresses||[]).join(', ')||'—'}</td>
              <td className="px-3 py-2 text-xs">
                <span className={`px-2 py-0.5 rounded ${d.status==='active'?'bg-green-100 text-green-700':'bg-slate-100 text-slate-500'}`}>{d.status}</span>
              </td>
              <td className="px-3 py-2 text-xs text-slate-400">{d.last_seen ? new Date(d.last_seen).toLocaleDateString() : '—'}</td>
            </tr>
          ))}
          {!devices.length && <tr><td colSpan={8} className="text-center text-slate-400 py-6">No devices synced yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Google Admin devices
// ---------------------------------------------------------------------------
function GoogleSection({ status }) {
  const configured = status?.google?.configured;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <StatusDot ok={configured}/>
        <span className="text-sm text-slate-600">{configured ? 'Connected via Workspace' : 'Not configured — set credentials in Settings'}</span>
        {configured && (
          <div className="ml-auto flex gap-2">
            <SyncButton label="Sync users/groups" endpoint="/integrations/sync/google"/>
            <SyncButton label="Sync devices" endpoint="/integrations/sync/google-devices"/>
          </div>
        )}
      </div>
      <ErrorBanner message={status?.google?.lastError}/>
      {configured && <DevicesTable source="google_admin"/>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mosyle
// ---------------------------------------------------------------------------
function MosyleSection({ status }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [token, setToken] = useState('');
  const configured = status?.mosyle?.configured;

  const save = async () => {
    await api.put('/settings', { mosyle_access_token: token });
    qc.invalidateQueries({queryKey:['integrations-status']});
    setModal(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <StatusDot ok={configured}/>
        <span className="text-sm text-slate-600">{configured ? 'Connected' : 'Not configured'}</span>
        <div className="ml-auto flex gap-2">
          <button onClick={()=>setModal(true)} className="text-xs text-slate-500 hover:text-slate-700 underline">Settings</button>
          {configured && <SyncButton label="Sync Apple devices" endpoint="/integrations/sync/mosyle"/>}
        </div>
      </div>
      <ErrorBanner message={status?.mosyle?.lastError}/>
      {configured && <DevicesTable source="mosyle"/>}
      {modal && (
        <Modal title="Mosyle Settings" onClose={()=>setModal(null)}>
          <Field label="Mosyle Access Token"><input type="password" className={INPUT} value={token} onChange={e=>setToken(e.target.value)}/></Field>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={save} className="btn-primary text-sm">Save</button>
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
  const [form, setForm]   = useState({ snipeit_url:'', snipeit_token:'' });
  const configured = status?.snipeit?.configured;

  const save = async () => {
    await api.put('/settings', form);
    qc.invalidateQueries({queryKey:['integrations-status']});
    setModal(null);
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
            <Field label="API Token"><input type="password" className={INPUT} value={form.snipeit_token} onChange={e=>setForm(f=>({...f,snipeit_token:e.target.value}))}/></Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={save} className="btn-primary text-sm">Save</button>
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
  const { data: resp2 } = useQuery({
    queryKey: ['int-devices-all', sourceFilter],
    queryFn: () => api.get(`/integrations/devices${sourceFilter ? `?source=${sourceFilter}` : ''}`),
  });
  const devices = resp2?.devices ?? resp2 ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <select value={sourceFilter} onChange={e=>setSourceFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500">
          <option value="">All sources</option>
          <option value="google_admin">Google Admin</option>
          <option value="mosyle">Mosyle</option>
          <option value="snipeit">Snipe-IT</option>
        </select>
        <span className="text-sm text-slate-500">{devices.length} devices</span>
      </div>
      <DevicesTable source={sourceFilter||null}/>
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
          {integrations.map(i=>(
            <Card key={i.id} title={i.label} icon={i.icon}
              subtitle={status[i.id]?.lastSync ? `Last sync: ${new Date(status[i.id].lastSync).toLocaleString()}` : 'Never synced'}>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <StatusDot ok={status[i.id]?.configured && !status[i.id]?.lastError}/>
                  <span className="text-sm text-slate-600">
                    {!status[i.id]?.configured ? 'Not configured' : status[i.id]?.lastError ? 'Sync failing' : 'Configured'}
                  </span>
                  {status[i.id]?.deviceCount !== undefined && (
                    <span className="ml-auto text-xs text-slate-400">{status[i.id].deviceCount} devices</span>
                  )}
                </div>
                <ErrorBanner message={status[i.id]?.lastError}/>
              </div>
            </Card>
          ))}
          <Card title="PHPiPAM Migration" icon="🔄" subtitle="One-time import from your existing PHPiPAM instance">
            <p className="text-sm text-slate-600">Import IP address database, subnets, and VLANs into ClassGuard IPAM.</p>
          </Card>
        </div>
      )}

      {tab==='All Devices'        && <AllDevicesTab/>}
      {tab==='Google Workspace'   && <GoogleSection status={status}/>}
      {tab==='Mosyle'             && <MosyleSection status={status}/>}
      {tab==='Snipe-IT'           && <SnipeitSection status={status}/>}
      {tab==='Zammad'             && <ZammadSection status={status}/>}
      {tab==='PHPiPAM Migration'  && <PhpipamSection/>}
    </div>
  );
}
