import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const INPUT  = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const VENDORS = ['unifi','meraki','aruba','ruckus'];
const VENDOR_LABELS = { unifi:'UniFi', meraki:'Meraki', aruba:'Aruba', ruckus:'Ruckus' };
const VENDOR_ICONS  = { unifi:'📡', meraki:'🔷', aruba:'🟠', ruckus:'🔴' };

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
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
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
// Controller form — adapts fields to vendor
// ---------------------------------------------------------------------------
const EMPTY_CTRL = { name:'', vendor:'unifi', base_url:'', site_id:'', username:'', password:'', api_key:'' };

function ControllerForm({ initial, onSave, onCancel, isPending }) {
  const [form, setForm] = useState(initial || EMPTY_CTRL);
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const needsUrl       = ['unifi','aruba','ruckus'].includes(form.vendor);
  const needsUserPass  = ['unifi','aruba','ruckus'].includes(form.vendor);
  const needsApiKey    = ['meraki','aruba'].includes(form.vendor);
  const needsSite      = ['unifi','meraki'].includes(form.vendor);

  return (
    <div className="flex flex-col gap-3">
      <Field label="Name (your label for this controller)">
        <input className={INPUT} value={form.name} onChange={e=>f('name',e.target.value)} placeholder="School Main UniFi"/>
      </Field>
      <Field label="Vendor">
        <select className={INPUT} value={form.vendor} onChange={e=>f('vendor',e.target.value)}>
          {VENDORS.map(v=><option key={v} value={v}>{VENDOR_LABELS[v]}</option>)}
        </select>
      </Field>
      {needsUrl && (
        <Field label={form.vendor==='unifi'?'Controller URL (e.g. https://192.168.1.1)':form.vendor==='aruba'?'Controller IP / Aruba Central URL':'SmartZone URL'}>
          <input className={INPUT} value={form.base_url} onChange={e=>f('base_url',e.target.value)}
            placeholder={form.vendor==='unifi'?'https://192.168.1.1:8443':'https://controller.example.com'}/>
        </Field>
      )}
      {needsSite && (
        <Field label={form.vendor==='unifi'?'Site name (default = "default")':'Meraki Network ID (L_xxxx)'}>
          <input className={INPUT} value={form.site_id} onChange={e=>f('site_id',e.target.value)}
            placeholder={form.vendor==='unifi'?'default':'L_123456789012345'}/>
        </Field>
      )}
      {needsApiKey && (
        <Field label={form.vendor==='meraki'?'Meraki Dashboard API Key':'Aruba Central Access Token'}>
          <input type="password" className={INPUT} value={form.api_key} onChange={e=>f('api_key',e.target.value)}/>
        </Field>
      )}
      {needsUserPass && (
        <>
          <Field label="Username">
            <input className={INPUT} value={form.username} onChange={e=>f('username',e.target.value)}/>
          </Field>
          <Field label="Password">
            <input type="password" className={INPUT} value={form.password} onChange={e=>f('password',e.target.value)}/>
          </Field>
        </>
      )}
      {form.vendor === 'aruba' && (
        <Field label="Mode">
          <select className={INPUT} value={form.extra_config?.mode||'controller'}
            onChange={e=>f('extra_config',{...(form.extra_config||{}),mode:e.target.value})}>
            <option value="controller">Aruba Controller (on-prem)</option>
            <option value="central">Aruba Central (cloud)</option>
          </select>
        </Field>
      )}
      <div className="flex justify-end gap-2 mt-2">
        <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
        <button onClick={()=>onSave(form)} disabled={isPending} className="btn-primary text-sm">
          {isPending?'Saving…':'Save'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controllers tab
// ---------------------------------------------------------------------------
function ControllersTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState({});

  const { data: controllers=[] } = useQuery({
    queryKey: ['network-controllers'],
    queryFn:  () => api.get('/network/controllers'),
    refetchInterval: 30_000,
  });

  const add = useMutation({
    mutationFn: form => api.post('/network/controllers', form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['network-controllers']}); setModal(null); },
  });

  const upd = useMutation({
    mutationFn: ({ id, ...form }) => api.put(`/network/controllers/${id}`, form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['network-controllers']}); setModal(null); },
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/network/controllers/${id}`),
    onSuccess: () => qc.invalidateQueries({queryKey:['network-controllers']}),
  });

  const sync = async (id) => {
    try { await api.post(`/network/controllers/${id}/sync`); }
    catch(e) { alert('Sync failed: ' + e.message); }
  };

  const test = async (id) => {
    setTesting(id);
    setTestResult(r => ({...r, [id]: null}));
    try {
      const r = await api.post(`/network/controllers/${id}/test`);
      setTestResult(r => ({...r, [id]: {ok:true, detail: JSON.stringify(r).slice(0,80)}}));
    } catch(e) {
      setTestResult(r => ({...r, [id]: {ok:false, detail: e.message}}));
    }
    setTesting(null);
  };

  const syncAll = async () => {
    try { await api.post('/network/sync-all'); }
    catch(e) { alert('Sync failed: ' + e.message); }
  };

  return (
    <>
      <div className="flex justify-end gap-2 mb-4">
        <button onClick={syncAll} className="btn-secondary text-sm">Sync All</button>
        <button onClick={()=>setModal('add')} className="btn-primary text-sm">+ Add Controller</button>
      </div>
      <div className="flex flex-col gap-3">
        {controllers.map(c=>(
          <div key={c.id} className={`bg-white border rounded-xl p-5 shadow-sm ${c.last_error?'border-red-200':'border-slate-200'}`}>
            <div className="flex items-start gap-3">
              <span className="text-2xl">{VENDOR_ICONS[c.vendor]||'🔌'}</span>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-900">{c.name}</span>
                  <span className="px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700">{VENDOR_LABELS[c.vendor]||c.vendor}</span>
                  {!c.is_active && <span className="px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-500">Disabled</span>}
                </div>
                <div className="text-xs text-slate-500 mt-1">{c.base_url||'Cloud API'} {c.site_id?`· Site: ${c.site_id}`:''}</div>
                <div className="flex gap-4 mt-2 text-xs text-slate-500">
                  <span><strong className="text-slate-700">{c.client_count||0}</strong> clients</span>
                  <span>Last sync: {c.last_sync ? new Date(c.last_sync).toLocaleString() : 'Never'}</span>
                </div>
                {c.last_error && <p className="text-xs text-red-500 mt-1">Error: {c.last_error}</p>}
                {testResult[c.id] && (
                  <p className={`text-xs mt-1 ${testResult[c.id].ok?'text-green-600':'text-red-500'}`}>
                    {testResult[c.id].ok?'✓ Connected':'✗ Failed'}: {testResult[c.id].detail}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1 items-end text-xs">
                <button onClick={()=>test(c.id)} disabled={testing===c.id} className="text-slate-500 hover:text-slate-700">
                  {testing===c.id?'Testing…':'Test'}
                </button>
                <button onClick={()=>sync(c.id)} className="text-primary-600 hover:underline">Sync Now</button>
                <button onClick={()=>setModal(c)} className="text-slate-500 hover:underline">Edit</button>
                <button onClick={()=>del.mutate(c.id)} className="text-red-500 hover:underline">Remove</button>
              </div>
            </div>
          </div>
        ))}
        {!controllers.length && <p className="text-center text-slate-400 py-12 text-sm">No network controllers added yet</p>}
      </div>
      {modal && (
        <Modal title={modal==='add'?'Add Network Controller':'Edit Controller'} onClose={()=>setModal(null)}>
          <ControllerForm
            initial={modal==='add' ? undefined : modal}
            onSave={form => modal==='add' ? add.mutate(form) : upd.mutate({id:modal.id,...form})}
            onCancel={()=>setModal(null)}
            isPending={add.isPending||upd.isPending}
          />
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Clients tab
// ---------------------------------------------------------------------------
function ClientsTab() {
  const [search, setSearch]   = useState('');
  const [ctrlFilter, setCtrl] = useState('');
  const [typeFilter, setType] = useState('');
  const [apFilter, setAp]     = useState('');

  const { data: resp } = useQuery({
    queryKey: ['network-clients', search, ctrlFilter, typeFilter, apFilter],
    queryFn: () => {
      const p = new URLSearchParams();
      if (search)     p.set('search', search);
      if (ctrlFilter) p.set('controller_id', ctrlFilter);
      if (typeFilter) p.set('type', typeFilter);
      if (apFilter)   p.set('ap', apFilter);
      return api.get(`/network/clients?${p}`);
    },
    refetchInterval: 30_000,
  });

  const { data: controllers=[] } = useQuery({
    queryKey: ['network-controllers'],
    queryFn:  () => api.get('/network/controllers'),
  });

  const clients = resp?.clients || [];

  const rssiBar = (rssi) => {
    if (rssi == null) return <span className="text-slate-300">—</span>;
    const abs   = Math.abs(rssi);
    const color = abs < 60 ? 'green' : abs < 75 ? 'yellow' : 'red';
    return (
      <span className={`text-xs font-mono text-${color}-600`}>{rssi} dBm</span>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search MAC, hostname, IP…"
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 flex-1 min-w-48"/>
        <select value={ctrlFilter} onChange={e=>setCtrl(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none">
          <option value="">All controllers</option>
          {controllers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={typeFilter} onChange={e=>setType(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none">
          <option value="">Wired + Wireless</option>
          <option value="wireless">Wireless only</option>
          <option value="wired">Wired only</option>
        </select>
        <span className="text-sm text-slate-500 self-center">{resp?.total||0} clients</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['MAC','IP','Hostname','AP / Switch','SSID / Port','VLAN','Signal','Type','Vendor','Last Seen',''].map(h=>(
              <th key={h} className="px-3 py-2 text-left">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {clients.map(c=>(
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs text-slate-800">{c.mac}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{c.ip_address||'—'}</td>
                <td className="px-3 py-2 text-xs text-slate-700">{c.hostname||'—'}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{c.ap_name||c.switch_name||'—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{c.ssid||c.switch_port||'—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{c.vlan||'—'}</td>
                <td className="px-3 py-2">{rssiBar(c.rssi)}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs ${c.connection_type==='wireless'?'bg-blue-100 text-blue-700':'bg-slate-100 text-slate-600'}`}>
                    {c.connection_type||'—'}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">{c.vendor_oui||c.controller_name}</td>
                <td className="px-3 py-2 text-xs text-slate-400">{c.last_seen ? new Date(c.last_seen).toLocaleTimeString() : '—'}</td>
                <td className="px-3 py-2">
                  <a href={`/admin/network/device/${c.mac}`} className="text-xs text-primary-600 hover:underline">Details</a>
                </td>
              </tr>
            ))}
            {!clients.length && <tr><td colSpan={11} className="text-center text-slate-400 py-8">No clients</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// APs tab
// ---------------------------------------------------------------------------
function ApsTab() {
  const { data: aps=[], isLoading } = useQuery({
    queryKey: ['network-aps'],
    queryFn:  () => api.get('/network/aps'),
    refetchInterval: 30_000,
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
          <tr>{['AP Name','Controller','Vendor','Online Clients','Total Clients','Avg Signal','Last Activity'].map(h=>(
            <th key={h} className="px-3 py-2 text-left">{h}</th>
          ))}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {aps.map((a,i)=>(
            <tr key={i} className="hover:bg-slate-50">
              <td className="px-3 py-2 font-semibold text-slate-800">{a.ap_name}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{a.controller_name}</td>
              <td className="px-3 py-2"><span className="px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700">{VENDOR_LABELS[a.vendor]||a.vendor}</span></td>
              <td className="px-3 py-2 font-bold text-slate-800">{a.online_clients}</td>
              <td className="px-3 py-2 text-slate-500">{a.total_clients}</td>
              <td className="px-3 py-2 text-xs font-mono text-slate-600">{a.avg_rssi ? `${parseFloat(a.avg_rssi).toFixed(0)} dBm` : '—'}</td>
              <td className="px-3 py-2 text-xs text-slate-400">{a.last_activity ? new Date(a.last_activity).toLocaleString() : '—'}</td>
            </tr>
          ))}
          {isLoading && <tr><td colSpan={7} className="text-center text-slate-400 py-6">Loading…</td></tr>}
          {!isLoading && !aps.length && <tr><td colSpan={7} className="text-center text-slate-400 py-8">No AP data — sync a controller first</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DNS Forward Zones tab (AD + internal DNS)
// ---------------------------------------------------------------------------
function ForwardZonesTab() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ domain:'', forward_to:'', description:'' });
  const [show, setShow] = useState(false);

  const { data: zones=[] } = useQuery({
    queryKey: ['dns-forward-zones'],
    queryFn:  () => api.get('/network/dns-forward-zones'),
  });

  const add = useMutation({
    mutationFn: () => api.post('/network/dns-forward-zones', form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['dns-forward-zones']}); setShow(false); setForm({domain:'',forward_to:'',description:''}); },
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/network/dns-forward-zones/${id}`),
    onSuccess: () => qc.invalidateQueries({queryKey:['dns-forward-zones']}),
  });

  const toggle = useMutation({
    mutationFn: ({ id, is_active }) => api.put(`/network/dns-forward-zones/${id}`, { is_active }),
    onSuccess: () => qc.invalidateQueries({queryKey:['dns-forward-zones']}),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        <strong>Windows Active Directory DNS</strong> — Add your AD internal domain here (e.g. <code className="bg-amber-100 px-1 rounded font-mono text-xs">school.local</code>
        ) and point it at your Domain Controller's IP. ClassGuard will forward all AD DNS queries directly to the DC without filtering.
        Windows PCs can then use ClassGuard as their primary DNS server and still receive Group Policy, Kerberos tickets, and SYSVOL access normally.
        <div className="mt-2 font-semibold">PC DNS setting: ClassGuard IP → AD queries auto-forwarded to DC transparently.</div>
      </div>
      <div className="flex justify-end">
        <button onClick={()=>setShow(v=>!v)} className="btn-primary text-sm">+ Add Forward Zone</button>
      </div>
      {show && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Internal Domain (e.g. school.local)">
              <input className={INPUT} value={form.domain} onChange={e=>setForm(f=>({...f,domain:e.target.value}))} placeholder="school.local"/>
            </Field>
            <Field label="Forward to (Domain Controller IP)">
              <input className={INPUT} value={form.forward_to} onChange={e=>setForm(f=>({...f,forward_to:e.target.value}))} placeholder="10.0.0.10"/>
            </Field>
            <Field label="Description (optional)">
              <input className={INPUT} value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} placeholder="Main AD domain controller"/>
            </Field>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={()=>setShow(false)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>add.mutate()} disabled={add.isPending} className="btn-primary text-sm">{add.isPending?'Saving…':'Add Zone'}</button>
          </div>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Domain','Forward To','Description','Active',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {zones.map(z=>(
              <tr key={z.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono font-semibold text-slate-800">{z.domain}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{z.forward_to}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{z.description||'—'}</td>
                <td className="px-3 py-2">
                  <button onClick={()=>toggle.mutate({id:z.id,is_active:!z.is_active})}
                    className={`w-9 h-5 rounded-full transition-colors ${z.is_active?'bg-green-400':'bg-slate-300'}`}>
                    <span className={`block w-4 h-4 bg-white rounded-full shadow transform transition-transform mx-0.5 ${z.is_active?'translate-x-4':'translate-x-0'}`}/>
                  </button>
                </td>
                <td className="px-3 py-2">
                  <button onClick={()=>del.mutate(z.id)} className="text-xs text-red-500 hover:underline">Remove</button>
                </td>
              </tr>
            ))}
            {!zones.length && (
              <tr><td colSpan={5} className="text-center text-slate-400 py-8">
                No forward zones — add your AD domain above
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = ['Controllers','Clients','Access Points','DNS Forward Zones'];

export default function NetworkPage() {
  const [tab, setTab] = useState('Controllers');

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">Network Infrastructure</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          UniFi, Meraki, Aruba, Ruckus — unified client view with AP/switch/port details.
          Multiple controllers per vendor supported.
        </p>
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

      {tab==='Controllers'       && <ControllersTab/>}
      {tab==='Clients'           && <ClientsTab/>}
      {tab==='Access Points'     && <ApsTab/>}
      {tab==='DNS Forward Zones' && <ForwardZonesTab/>}
    </div>
  );
}
