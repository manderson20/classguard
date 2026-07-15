import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import FailoverPriorityList from '../../components/FailoverPriorityList';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------
const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const SELECT = INPUT + ' bg-white';

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      <span>{label}{hint && <span className="font-normal text-slate-400 ml-1">— {hint}</span>}</span>
      {children}
    </label>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-xl shadow-xl ${wide ? 'w-full max-w-3xl' : 'w-full max-w-lg'} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    approved: 'bg-green-100 text-green-800',
    blocked:  'bg-red-100 text-red-800',
    pending:  'bg-amber-100 text-amber-800',
  };
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${map[status] || 'bg-slate-100 text-slate-600'}`}>{status}</span>;
}

const SOURCE_STYLE = {
  mosyle:             { bg: 'bg-blue-100',   text: 'text-blue-700',   label: 'Mosyle'      },
  snipeit:            { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Snipe-IT'    },
  google_admin:       { bg: 'bg-indigo-100', text: 'text-indigo-700', label: 'Google Admin' },
  network_controller: { bg: 'bg-teal-100',   text: 'text-teal-700',   label: 'Network'     },
  radius_seen:        { bg: 'bg-orange-100', text: 'text-orange-700', label: 'RADIUS seen' },
  manual:             { bg: 'bg-slate-100',  text: 'text-slate-600',  label: 'Manual'      },
};

function SourceBadge({ source, inactive }) {
  const s = SOURCE_STYLE[source] || { bg:'bg-slate-100', text:'text-slate-500', label: source };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${s.bg} ${s.text} ${inactive?'opacity-40 line-through':''}`} title={inactive?'Removed from this source':undefined}>
      {s.label}
    </span>
  );
}

function SourcesList({ sources = [] }) {
  if (!sources.length) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {sources.map(s => (
        <SourceBadge key={s.source} source={s.source} inactive={!s.is_active}/>
      ))}
    </div>
  );
}

function ResultBadge({ result }) {
  if (!result) return null;
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${result === 'accepted' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
      {result}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Overview Tab
// ---------------------------------------------------------------------------
function OverviewTab() {
  const { data: stats = {} } = useQuery({
    queryKey: ['radius-stats'],
    queryFn:  () => api.get('/radius/stats'),
    refetchInterval: 15_000,
  });

  const { data: logData = [] } = useQuery({
    queryKey: ['radius-log-recent'],
    queryFn:  () => api.get('/radius/log?limit=15'),
    refetchInterval: 10_000,
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Active sessions',    value: stats.active_sessions ?? '—', color: 'blue'  },
          { label: 'Accepted (24h)',      value: stats.accepted_24h    ?? '—', color: 'green' },
          { label: 'Rejected (24h)',      value: stats.rejected_24h    ?? '—', color: 'red'   },
          { label: 'Pending devices',     value: stats.pending_devices ?? '—', color: 'amber' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white border border-slate-200 rounded-xl p-4 text-center shadow-sm">
            <div className={`text-3xl font-bold text-${color}-600`}>{value}</div>
            <div className="text-xs text-slate-500 mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Architecture diagram / explanation */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">
        <h3 className="font-semibold text-slate-800 text-sm mb-3">IP Address Architecture</h3>
        <div className="grid md:grid-cols-3 gap-4 text-xs text-slate-600">
          <div className="bg-white rounded-lg p-3 border border-blue-200">
            <div className="font-semibold text-blue-800 mb-1">Primary Node (real IP)</div>
            <div>DNS resolver — listed in DHCP Option 6</div>
            <div className="text-slate-400 mt-1">Always answers DNS independently</div>
          </div>
          <div className="bg-white rounded-lg p-3 border border-blue-200">
            <div className="font-semibold text-blue-800 mb-1">Secondary Node (real IP)</div>
            <div>DNS resolver — also in DHCP Option 6</div>
            <div className="text-slate-400 mt-1">Also set as fallback RADIUS on switches/APs</div>
          </div>
          <div className="bg-white rounded-lg p-3 border border-primary-200">
            <div className="font-semibold text-primary-800 mb-1">VIP (Keepalived VRRP)</div>
            <div>RADIUS · DHCP · Web UI</div>
            <div className="text-slate-400 mt-1">Floats to standby if primary fails (~2s)</div>
          </div>
        </div>
      </div>

      {/* Recent auth log */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-semibold text-slate-800 text-sm">Recent auth activity</h3>
          <span className="text-xs text-slate-400">auto-refreshes every 10s</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>{['Time','User / MAC','SSID','Auth type','Result','Reason'].map(h=>
                <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logData.map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{new Date(r.logged_at).toLocaleTimeString()}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.username || r.mac_address || '—'}</td>
                  <td className="px-3 py-2 text-xs">{r.ssid || '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.auth_type || '—'}</td>
                  <td className="px-3 py-2"><ResultBadge result={r.result}/></td>
                  <td className="px-3 py-2 text-xs text-slate-400 truncate max-w-xs">{r.reject_reason || '—'}</td>
                </tr>
              ))}
              {!logData.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-400">No auth activity yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NAS Clients Tab
// ---------------------------------------------------------------------------
const VENDORS = ['unifi','meraki','aruba','ruckus','cisco','other'];
const EMPTY_NAS = { name:'', shortname:'', ip_address:'', shared_secret:'', vendor:'other', description:'', default_vlan:'' };

function NasTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY_NAS);

  const { data: nas = [] } = useQuery({ queryKey: ['radius-nas'], queryFn: () => api.get('/radius/nas') });

  const add = useMutation({
    mutationFn: () => api.post('/radius/nas', form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['radius-nas']}); setModal(null); },
  });
  const upd = useMutation({
    mutationFn: () => api.put(`/radius/nas/${modal?.id}`, form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['radius-nas']}); setModal(null); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/radius/nas/${id}`),
    onSuccess: () => qc.invalidateQueries({queryKey:['radius-nas']}),
  });

  const f = (k, v) => setForm(p => ({...p, [k]: v}));

  const NasForm = () => (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" hint="e.g. Main Office Switch">
          <input className={INPUT} value={form.name} onChange={e=>f('name',e.target.value)} placeholder="Core-Switch-01"/>
        </Field>
        <Field label="Short name" hint="no spaces">
          <input className={INPUT} value={form.shortname} onChange={e=>f('shortname',e.target.value)} placeholder="core-sw-01"/>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="IP Address">
          <input className={INPUT} value={form.ip_address} onChange={e=>f('ip_address',e.target.value)} placeholder="192.168.1.1"/>
        </Field>
        <Field label="Vendor">
          <select className={SELECT} value={form.vendor} onChange={e=>f('vendor',e.target.value)}>
            {VENDORS.map(v=><option key={v} value={v}>{v}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Shared secret" hint="must match switch/AP RADIUS config">
        <input type="password" className={INPUT} value={form.shared_secret} onChange={e=>f('shared_secret',e.target.value)} placeholder="••••••••"/>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default VLAN" hint="optional">
          <input type="number" className={INPUT} value={form.default_vlan} onChange={e=>f('default_vlan',e.target.value)} placeholder="10"/>
        </Field>
        <Field label="Description" hint="optional">
          <input className={INPUT} value={form.description} onChange={e=>f('description',e.target.value)}/>
        </Field>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800 mt-1">
        <strong>Switch/AP config tip:</strong> Set primary RADIUS = VIP address · Set secondary RADIUS = Secondary node real IP · Timeout = 5s · 3 retries. This gives sub-5s failover without relying solely on Keepalived.
      </div>

      <div className="flex justify-end gap-2 mt-2">
        <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
        <button onClick={()=>modal==='add'?add.mutate():upd.mutate()} disabled={add.isPending||upd.isPending} className="btn-primary text-sm">
          {add.isPending||upd.isPending?'Saving…':'Save'}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="flex justify-end mb-4">
        <button onClick={()=>{setForm(EMPTY_NAS);setModal('add')}} className="btn-primary text-sm">+ Add NAS Client</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Name','IP Address','Vendor','Default VLAN','Status',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {nas.map(n=>(
              <tr key={n.id} className="hover:bg-slate-50">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{n.name}</div>
                  <div className="text-xs text-slate-400">{n.shortname}</div>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{n.ip_address}</td>
                <td className="px-3 py-2 text-xs capitalize text-slate-500">{n.vendor}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{n.default_vlan || '—'}</td>
                <td className="px-3 py-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${n.is_active?'bg-green-100 text-green-800':'bg-slate-100 text-slate-500'}`}>
                    {n.is_active?'active':'inactive'}
                  </span>
                </td>
                <td className="px-3 py-2 text-right space-x-2 text-xs">
                  <button onClick={()=>{setForm({...n,shared_secret:''});setModal(n)}} className="text-slate-500 hover:underline">Edit</button>
                  <button onClick={()=>del.mutate(n.id)} className="text-red-500 hover:underline">Remove</button>
                </td>
              </tr>
            ))}
            {!nas.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-400">No NAS clients yet — add your switches and access points</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && <Modal title={modal==='add'?'Add NAS Client':'Edit NAS Client'} onClose={()=>setModal(null)}><NasForm/></Modal>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Devices (NAC) Tab
// ---------------------------------------------------------------------------
const DEVICE_TYPES = ['laptop','desktop','phone','tablet','chromebook','printer','tv','ap','switch','server','other'];
const EMPTY_DEVICE = { mac_address:'', device_name:'', device_type:'other', status:'approved', assigned_vlan:'', notes:'' };

function DevicesTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [typeFilter, setTypeFilter]     = useState('');
  const [search, setSearch]             = useState('');
  const [selected, setSelected]         = useState(new Set());
  const [editModal, setEditModal]       = useState(null);
  const [addModal, setAddModal]         = useState(false);
  const [addForm, setAddForm]           = useState(EMPTY_DEVICE);
  const [syncing, setSyncing]           = useState(false);
  const [filterBulkMsg, setFilterBulkMsg] = useState(null);

  const { data = { devices: [], counts: {}, total: 0 } } = useQuery({
    queryKey: ['radius-devices', statusFilter, sourceFilter, typeFilter, search],
    queryFn:  () => {
      const p = new URLSearchParams({ limit: 200 });
      if (statusFilter) p.set('status', statusFilter);
      if (sourceFilter) p.set('source', sourceFilter);
      if (typeFilter)   p.set('device_type', typeFilter);
      if (search)       p.set('search', search);
      return api.get('/radius/devices?' + p);
    },
    refetchInterval: 20_000,
  });

  const updateDev = useMutation({
    mutationFn: ({ id, ...body }) => api.put(`/radius/devices/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({queryKey:['radius-devices']}); setEditModal(null); },
  });

  const addDev = useMutation({
    mutationFn: () => api.post('/radius/devices', addForm),
    onSuccess: () => { qc.invalidateQueries({queryKey:['radius-devices']}); setAddModal(false); setAddForm(EMPTY_DEVICE); },
  });

  const bulk = useMutation({
    mutationFn: status => api.post('/radius/devices/bulk', { ids: [...selected], status }),
    onSuccess: () => { qc.invalidateQueries({queryKey:['radius-devices']}); setSelected(new Set()); },
  });

  const hasActiveFilter = !!(statusFilter || sourceFilter || typeFilter || search);
  const bulkByFilter = useMutation({
    mutationFn: newStatus => api.post('/radius/devices/bulk-by-filter', {
      status: statusFilter || undefined, source: sourceFilter || undefined,
      device_type: typeFilter || undefined, search: search || undefined, newStatus,
    }),
    onSuccess: (res, newStatus) => {
      qc.invalidateQueries({queryKey:['radius-devices']});
      setFilterBulkMsg(`${res.updated} device(s) set to ${newStatus}`);
    },
  });

  const syncDevices = async () => {
    setSyncing(true);
    try { await api.post('/radius/sync-devices'); }
    finally { setTimeout(()=>{ setSyncing(false); qc.invalidateQueries({queryKey:['radius-devices']}); }, 3000); }
  };

  const toggleSel = id => setSelected(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const selAll    = () => setSelected(new Set(data.devices.map(d=>d.id)));
  const selNone   = () => setSelected(new Set());

  const c = data.counts || {};
  const total_pending  = parseInt(c.pending  || 0);
  const total_approved = parseInt(c.approved || 0);
  const total_blocked  = parseInt(c.blocked  || 0);

  const EditModal = ({ dev }) => {
    const [form, setForm] = useState({
      status:       dev.status,
      device_name:  dev.device_name || '',
      device_type:  dev.device_type || 'other',
      assigned_vlan: dev.assigned_vlan || '',
      notes:        dev.notes || '',
    });
    const f = (k, v) => setForm(p=>({...p,[k]:v}));
    return (
      <Modal title="Edit Device" onClose={()=>setEditModal(null)}>
        <div className="flex flex-col gap-3">
          <div className="bg-slate-50 rounded-lg p-3 font-mono text-sm text-slate-700">{dev.mac_address}</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <select className={SELECT} value={form.status} onChange={e=>f('status',e.target.value)}>
                <option value="approved">Approved — allow network access</option>
                <option value="blocked">Blocked — always reject</option>
                <option value="pending">Pending — hold for review</option>
              </select>
            </Field>
            <Field label="Device type">
              <select className={SELECT} value={form.device_type} onChange={e=>f('device_type',e.target.value)}>
                {DEVICE_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Device name">
            <input className={INPUT} value={form.device_name} onChange={e=>f('device_name',e.target.value)} placeholder="Lab-MacBook-01"/>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Assigned VLAN" hint="overrides policy">
              <input type="number" className={INPUT} value={form.assigned_vlan} onChange={e=>f('assigned_vlan',e.target.value)} placeholder="20"/>
            </Field>
          </div>
          <Field label="Notes">
            <textarea className={INPUT + ' resize-none'} rows={2} value={form.notes} onChange={e=>f('notes',e.target.value)}
              placeholder="Smart TV in Room 101 — no network access"/>
          </Field>
          {/* Source feed details */}
          {(dev.sources||[]).length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
              <div className="text-xs font-semibold text-slate-600 mb-2">Data sources for this device</div>
              <div className="space-y-1.5">
                {dev.sources.map(s=>(
                  <div key={s.source} className="flex items-start gap-2 text-xs">
                    <SourceBadge source={s.source} inactive={!s.is_active}/>
                    <div className="flex-1 text-slate-500">
                      {s.source_name && <span className="mr-1">{s.source_name}</span>}
                      {s.source_device_id && <span className="font-mono text-slate-400 mr-1">#{s.source_device_id}</span>}
                      {s.is_active
                        ? <span className="text-green-600">Active · synced {new Date(s.last_synced_at).toLocaleDateString()}</span>
                        : <span className="text-red-500">Removed {s.removed_at ? new Date(s.removed_at).toLocaleDateString() : ''} — device may have been decommissioned or graduated</span>
                      }
                      {s.source_extra?.assigned_to && <span className="ml-1 text-slate-400">({s.source_extra.assigned_to})</span>}
                      {s.source_extra?.annotated_user && <span className="ml-1 text-slate-400">({s.source_extra.annotated_user})</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {form.status === 'blocked' && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-800">
              This device will be rejected at the WiFi level — it cannot connect to any network.
            </div>
          )}
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={()=>setEditModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>updateDev.mutate({id:dev.id,...form})} disabled={updateDev.isPending} className="btn-primary text-sm">
              {updateDev.isPending?'Saving…':'Save'}
            </button>
          </div>
        </div>
      </Modal>
    );
  };

  const AddModal = () => {
    const f = (k, v) => setAddForm(p=>({...p,[k]:v}));
    return (
      <Modal title="Add Device" onClose={()=>setAddModal(false)}>
        <div className="flex flex-col gap-3">
          <Field label="MAC Address">
            <input className={INPUT} value={addForm.mac_address} onChange={e=>f('mac_address',e.target.value)} placeholder="AA:BB:CC:DD:EE:FF"/>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <select className={SELECT} value={addForm.status} onChange={e=>f('status',e.target.value)}>
                <option value="approved">Approved</option>
                <option value="blocked">Blocked</option>
                <option value="pending">Pending</option>
              </select>
            </Field>
            <Field label="Device type">
              <select className={SELECT} value={addForm.device_type} onChange={e=>f('device_type',e.target.value)}>
                {DEVICE_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Device name">
            <input className={INPUT} value={addForm.device_name} onChange={e=>f('device_name',e.target.value)}/>
          </Field>
          <Field label="Assigned VLAN" hint="optional">
            <input type="number" className={INPUT} value={addForm.assigned_vlan} onChange={e=>f('assigned_vlan',e.target.value)}/>
          </Field>
          <Field label="Notes" hint="optional">
            <textarea className={INPUT + ' resize-none'} rows={2} value={addForm.notes} onChange={e=>f('notes',e.target.value)}
              placeholder="Smart TV in Library — blocked per IT policy"/>
          </Field>
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={()=>setAddModal(false)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>addDev.mutate()} disabled={addDev.isPending} className="btn-primary text-sm">
              {addDev.isPending?'Adding…':'Add Device'}
            </button>
          </div>
        </div>
      </Modal>
    );
  };

  return (
    <>
      {/* Count pills */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {[
          { s:'', label:`All (${total_approved+total_blocked+total_pending})`, color:'slate' },
          { s:'pending',  label:`Pending (${total_pending})`,  color:'amber' },
          { s:'approved', label:`Approved (${total_approved})`, color:'green' },
          { s:'blocked',  label:`Blocked (${total_blocked})`,  color:'red'   },
        ].map(({s, label, color})=>(
          <button key={s} onClick={()=>setStatusFilter(s)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors
              ${statusFilter===s ? `bg-${color}-600 text-white border-${color}-600` : `text-${color}-700 border-${color}-200 bg-${color}-50 hover:bg-${color}-100`}`}>
            {label}
          </button>
        ))}

        <div className="ml-auto flex gap-2">
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search MAC or name…"
            className="border border-slate-300 rounded-lg px-3 py-1.5 text-xs w-48 focus:outline-none focus:ring-1 focus:ring-primary-500"/>
          <select className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white" value={sourceFilter} onChange={e=>setSourceFilter(e.target.value)}>
            <option value="">All sources</option>
            {['mosyle','snipeit','google_admin','radius_seen','manual'].map(s=><option key={s} value={s}>{s.replace('_',' ')}</option>)}
          </select>
          <select className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white" value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}>
            <option value="">All categories</option>
            {DEVICE_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
          </select>
          <button onClick={syncDevices} disabled={syncing} className="btn-secondary text-xs">
            {syncing?'Syncing…':'Sync from MDM'}
          </button>
          <button onClick={()=>setAddModal(true)} className="btn-primary text-xs">+ Add Device</button>
        </div>
      </div>

      {/* Bulk actions on selected rows (current page) */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 bg-primary-50 border border-primary-200 rounded-lg px-4 py-2">
          <span className="text-sm font-medium text-primary-800">{selected.size} selected</span>
          <button onClick={()=>bulk.mutate('approved')} className="text-xs text-green-700 hover:underline font-semibold">Approve all</button>
          <button onClick={()=>bulk.mutate('blocked')}  className="text-xs text-red-700 hover:underline font-semibold">Block all</button>
          <button onClick={selNone} className="text-xs text-slate-500 hover:underline ml-auto">Clear selection</button>
        </div>
      )}

      {/* Bulk action across every device matching the filters above, not just this page */}
      {hasActiveFilter && (
        <div className="flex items-center gap-3 mb-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          <span className="text-sm font-medium text-amber-800">
            Apply to ALL devices matching this filter ({data.total} total, not just the {data.devices.length} shown)
          </span>
          <button onClick={()=>{ if(confirm(`Set ALL ${data.total} matching devices to approved?`)) bulkByFilter.mutate('approved'); }}
            disabled={bulkByFilter.isPending} className="text-xs text-green-700 hover:underline font-semibold">
            Approve all matching
          </button>
          <button onClick={()=>{ if(confirm(`Set ALL ${data.total} matching devices to blocked?`)) bulkByFilter.mutate('blocked'); }}
            disabled={bulkByFilter.isPending} className="text-xs text-red-700 hover:underline font-semibold">
            Block all matching
          </button>
          {filterBulkMsg && <span className="text-xs text-amber-700 ml-auto">{filterBulkMsg}</span>}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>
              <th className="px-3 py-2"><input type="checkbox" onChange={e=>e.target.checked?selAll():selNone()} checked={selected.size===data.devices.length&&data.devices.length>0}/></th>
              {['MAC Address','Device','Type','Data Sources','Status','Last seen','Auth',''].map(h=>
                <th key={h} className="px-3 py-2 text-left">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.devices.map(d=>(
              <tr key={d.id} className={`hover:bg-slate-50 ${d.status==='blocked'?'bg-red-50/30':d.status==='pending'?'bg-amber-50/30':''}`}>
                <td className="px-3 py-2"><input type="checkbox" checked={selected.has(d.id)} onChange={()=>toggleSel(d.id)}/></td>
                <td className="px-3 py-2 font-mono text-xs text-slate-700">{d.mac_address}</td>
                <td className="px-3 py-2">
                  <div className="text-sm font-medium text-slate-800">{d.device_name || '—'}</div>
                  {d.assigned_user_name && <div className="text-xs text-slate-400">{d.assigned_user_name}</div>}
                  {d.notes && <div className="text-xs text-slate-400 italic truncate max-w-xs">{d.notes}</div>}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500 capitalize">{d.device_type}</td>
                <td className="px-3 py-2 max-w-xs"><SourcesList sources={d.sources||[]}/></td>
                <td className="px-3 py-2"><StatusBadge status={d.status}/></td>
                <td className="px-3 py-2 text-xs text-slate-400">
                  {d.last_seen ? new Date(d.last_seen).toLocaleDateString() : '—'}
                </td>
                <td className="px-3 py-2"><ResultBadge result={d.last_auth_result}/></td>
                <td className="px-3 py-2">
                  <button onClick={()=>setEditModal(d)} className="text-xs text-primary-600 hover:underline">Edit</button>
                </td>
              </tr>
            ))}
            {!data.devices.length && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-slate-400">
                {statusFilter === 'pending' ? 'No pending devices — all devices have been reviewed' : 'No devices yet — click "Sync from MDM" to import from Mosyle, Snipe-IT, and Google Admin'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editModal && <EditModal dev={editModal}/>}
      {addModal  && <AddModal/>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Wi-Fi Policies Tab — controls which SSID a user/group can reach and which
// VLAN they land in. A policy with no specific user/group is a "default"
// that applies to anyone authenticating on the matching SSID — the typical
// shape for a BYOD/personal-device SSID where any Google Workspace user
// should be able to connect without being added to a group first.
// ---------------------------------------------------------------------------
const EMPTY_POLICY = { target: 'default', user_id: '', group_id: '', google_ou: '', email_domain: '', ssid: '', vlan: '', can_access: true, priority: 0, notes: '' };

function PolicyModal({ initial, onSave, onCancel, isPending }) {
  const [form, setForm] = useState(initial || EMPTY_POLICY);
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const [userSearch, setUserSearch] = useState('');

  const { data: users = [] } = useQuery({
    queryKey: ['radius-policy-user-search', userSearch],
    queryFn:  () => api.get(`/users?search=${encodeURIComponent(userSearch)}&limit=20`).then(r => r.users),
    enabled:  form.target === 'user' && userSearch.length > 1,
  });
  const { data: groups = [] } = useQuery({
    queryKey: ['groups'],
    queryFn:  () => api.get('/groups'),
    enabled:  form.target === 'group',
  });
  const { data: ous = [] } = useQuery({
    queryKey: ['radius-ou-list'],
    queryFn:  () => api.get('/radius/ou-list'),
    enabled:  form.target === 'ou',
  });

  const canSave =
    form.target === 'default' ? !!form.ssid :
    form.target === 'domain' ? !!form.ssid && !!form.email_domain :
    form.target === 'ou'    ? !!form.ssid && !!form.google_ou :
    form.target === 'user'  ? !!form.user_id :
    form.target === 'group' ? !!form.group_id : true;

  return (
    <div className="flex flex-col gap-3">
      <Field label="Applies to">
        <select className={SELECT} value={form.target} onChange={e=>f('target', e.target.value)}>
          <option value="default">Anyone (default for this SSID)</option>
          <option value="user">A specific user</option>
          <option value="group">A specific group</option>
          <option value="ou">A Google OU</option>
          <option value="domain">An email domain</option>
        </select>
      </Field>

      {form.target === 'user' && (
        <Field label="User" hint="search by name or email">
          <input className={INPUT} value={userSearch} onChange={e=>setUserSearch(e.target.value)} placeholder="Start typing…"/>
          {(users.length > 0 || form.user_id) && (
            <select className={SELECT + ' mt-1'} value={form.user_id} onChange={e=>f('user_id', e.target.value)}>
              <option value="">Select a user…</option>
              {form.user_id && !users.some(u=>String(u.id)===String(form.user_id)) &&
                <option value={form.user_id}>{form._userLabel || 'Current selection'}</option>}
              {users.map(u=><option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
            </select>
          )}
        </Field>
      )}

      {form.target === 'group' && (
        <Field label="Group">
          <select className={SELECT} value={form.group_id} onChange={e=>f('group_id', e.target.value)}>
            <option value="">Select a group…</option>
            {groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          {!groups.length && <p className="text-xs text-amber-600 mt-1">No groups exist yet.</p>}
        </Field>
      )}

      {form.target === 'ou' && (
        <Field label="Google OU" hint="includes all sub-OUs — a policy for /Students also covers /Students/High School">
          <select className={SELECT} value={form.google_ou} onChange={e=>f('google_ou', e.target.value)}>
            <option value="">Select an OU…</option>
            {ous.map(path=><option key={path} value={path}>{path}</option>)}
          </select>
          {!ous.length && <p className="text-xs text-amber-600 mt-1">No OUs synced yet — run a Google Workspace sync first.</p>}
        </Field>
      )}

      {form.target === 'domain' && (
        <Field label="Email domain" hint="exact match on the part after @ — e.g. students.school.org and school.org are treated as different domains">
          <input className={INPUT} value={form.email_domain} onChange={e=>f('email_domain', e.target.value.toLowerCase())} placeholder="students.school.org"/>
        </Field>
      )}

      {form.target === 'default' && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          This applies to <strong>any</strong> authenticated user on the SSID below — an SSID is required so it can't accidentally apply everywhere.
        </p>
      )}

      {form.target === 'domain' && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Applies to <strong>every</strong> account whose email ends in this domain, on the SSID below — checked before ClassGuard even needs to know who the specific user is, so it works whether or not that account is synced into Users yet. An SSID is required so it can't accidentally apply across every network.
        </p>
      )}

      {form.target === 'ou' && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Applies to every account in this OU <strong>or any OU beneath it</strong>, on the SSID below. Only works for accounts synced from Google Admin — an account ClassGuard has never synced has no OU to match, so pair a broad OU allow with a deny default policy on the same SSID. An SSID is required so it can't accidentally apply across every network.
        </p>
      )}

      <Field label="SSID" hint={(form.target === 'default' || form.target === 'domain' || form.target === 'ou') ? 'required' : 'leave blank to apply to all SSIDs'}>
        <input className={INPUT} value={form.ssid} onChange={e=>f('ssid', e.target.value)} placeholder="e.g. SchoolName-BYOD"/>
      </Field>
      <Field label="VLAN" hint="leave blank to use the NAS default VLAN">
        <input className={INPUT} type="number" value={form.vlan} onChange={e=>f('vlan', e.target.value)} placeholder="e.g. 40"/>
      </Field>
      <Field label="Priority" hint="higher evaluated first when multiple policies could match">
        <input className={INPUT} type="number" value={form.priority} onChange={e=>f('priority', e.target.value)}/>
      </Field>
      <Field label="Can access">
        <select className={SELECT} value={form.can_access ? '1' : '0'} onChange={e=>f('can_access', e.target.value==='1')}>
          <option value="1">Allow</option>
          <option value="0">Deny</option>
        </select>
      </Field>
      <Field label="Notes">
        <input className={INPUT} value={form.notes} onChange={e=>f('notes', e.target.value)}/>
      </Field>

      <div className="flex justify-end gap-2 mt-2">
        <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
        <button onClick={()=>onSave(form)} disabled={isPending || !canSave} className="btn-primary text-sm">
          {isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function PoliciesTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);

  const { data: policies = [] } = useQuery({
    queryKey: ['radius-policies'],
    queryFn:  () => api.get('/radius/policies'),
  });

  const toPayload = form => ({
    user_id:      form.target === 'user'   ? form.user_id     || null : null,
    group_id:     form.target === 'group'  ? form.group_id    || null : null,
    google_ou:    form.target === 'ou'     ? form.google_ou   || null : null,
    email_domain: form.target === 'domain' ? form.email_domain || null : null,
    ssid: form.ssid || null, vlan: form.vlan || null,
    can_access: form.can_access, priority: form.priority || 0, notes: form.notes || null,
  });

  const add = useMutation({
    mutationFn: form => api.post('/radius/policies', toPayload(form)),
    onSuccess: () => { qc.invalidateQueries({queryKey:['radius-policies']}); setModal(null); },
  });

  const edit = useMutation({
    mutationFn: ({ id, form }) => api.put(`/radius/policies/${id}`, toPayload(form)),
    onSuccess: () => { qc.invalidateQueries({queryKey:['radius-policies']}); setModal(null); },
  });

  // Map a policy row back into the modal's form shape. _userLabel keeps the
  // current user's name visible in the select before any new search runs.
  const toForm = p => ({
    target: p.user_id ? 'user' : p.group_id ? 'group' : p.google_ou ? 'ou' : p.email_domain ? 'domain' : 'default',
    user_id: p.user_id || '', group_id: p.group_id || '', google_ou: p.google_ou || '', email_domain: p.email_domain || '',
    ssid: p.ssid || '', vlan: p.vlan ?? '', can_access: p.can_access, priority: p.priority ?? 0, notes: p.notes || '',
    _userLabel: p.full_name ? `${p.full_name} (${p.email})` : '',
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/radius/policies/${id}`),
    onSuccess: () => qc.invalidateQueries({queryKey:['radius-policies']}),
  });

  const targetLabel = p => p.full_name ? `${p.full_name} (${p.email})` : p.group_name ? `Group: ${p.group_name}` : p.google_ou ? `OU: ${p.google_ou}` : p.email_domain ? `Domain: @${p.email_domain}` : 'Anyone (default)';

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
        Controls which SSID a user/group/Google OU/email domain can authenticate on (via username + Google credentials, EAP) and which VLAN they land in.
        An OU rule covers the OU and everything beneath it (e.g. /Students covers /Students/High School/11th Grade) and follows users automatically as Google sync moves them between OUs.
        A domain rule (e.g. deny @students.school.org on the staff SSID) is checked before ClassGuard even needs to know who the
        specific user is, so it works regardless of whether that account is synced into Users.
        Doesn't apply to MAC-based device auth (Devices / NAC tab) — that's governed by device approval status instead.
      </div>
      <div className="flex justify-end">
        <button onClick={()=>setModal('add')} className="btn-primary text-sm">+ Add Policy</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Applies to','SSID','VLAN','Access','Priority','Notes',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {policies.map(p=>(
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-sm text-slate-800">{targetLabel(p)}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{p.ssid || 'All SSIDs'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{p.vlan ?? '—'}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs ${p.can_access?'bg-green-100 text-green-700':'bg-red-100 text-red-700'}`}>
                    {p.can_access ? 'Allow' : 'Deny'}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{p.priority}</td>
                <td className="px-3 py-2 text-xs text-slate-400">{p.notes || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <button onClick={()=>setModal({ mode:'edit', policy:p })} className="text-xs text-primary-600 hover:underline mr-3">Edit</button>
                  <button onClick={()=>del.mutate(p.id)} className="text-xs text-red-500 hover:underline">Remove</button>
                </td>
              </tr>
            ))}
            {!policies.length && <tr><td colSpan={7} className="text-center text-slate-400 py-8">No policies yet — devices authenticate with default VLAN/access</td></tr>}
          </tbody>
        </table>
      </div>
      {modal==='add' && (
        <Modal title="Add Wi-Fi Policy" onClose={()=>setModal(null)}>
          <PolicyModal onSave={form=>add.mutate(form)} onCancel={()=>setModal(null)} isPending={add.isPending}/>
        </Modal>
      )}
      {modal?.mode==='edit' && (
        <Modal title="Edit Wi-Fi Policy" onClose={()=>setModal(null)}>
          <PolicyModal initial={toForm(modal.policy)}
            onSave={form=>edit.mutate({ id: modal.policy.id, form })}
            onCancel={()=>setModal(null)} isPending={edit.isPending}/>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth Log Tab
// ---------------------------------------------------------------------------
function LogTab() {
  const [resultFilter, setResultFilter] = useState('');
  const [search, setSearch] = useState('');

  const { data: log = [] } = useQuery({
    queryKey: ['radius-log', resultFilter, search],
    queryFn:  () => api.get(`/radius/log?limit=200${resultFilter ? '&result='+resultFilter : ''}${search ? '&search='+encodeURIComponent(search) : ''}`),
    refetchInterval: 10_000,
  });

  return (
    <>
      <div className="flex gap-2 mb-4 items-center">
        {[['','All'],['accepted','Accepted'],['rejected','Rejected']].map(([v,l])=>(
          <button key={v} onClick={()=>setResultFilter(v)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors
              ${resultFilter===v ? 'bg-primary-600 text-white border-primary-600' : 'text-slate-600 border-slate-200 hover:bg-slate-100'}`}>
            {l}
          </button>
        ))}
        <input className={INPUT + ' !w-64 text-xs'} value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Filter by user or MAC…"/>
        <span className="ml-auto text-xs text-slate-400 self-center">auto-refreshes every 10s</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Time','User / MAC','NAS IP','SSID','Auth type','VLAN','Result','Reason'].map(h=>
              <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {log.map(r=>(
              <tr key={r.id} className={`hover:bg-slate-50 ${r.result==='rejected'?'bg-red-50/20':''}`}>
                <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{new Date(r.logged_at).toLocaleString()}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.username || r.mac_address || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.nas_ip || '—'}</td>
                <td className="px-3 py-2 text-xs">{r.ssid || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.auth_type || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.vlan_assigned || '—'}</td>
                <td className="px-3 py-2"><ResultBadge result={r.result}/></td>
                <td className="px-3 py-2 text-xs text-slate-400 max-w-xs truncate">{r.reject_reason || '—'}</td>
              </tr>
            ))}
            {!log.length && <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">No log entries yet</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// User Devices Tab — every (user, device) pair seen by Wi-Fi user auth:
// which devices has this person connected with, when, and where. Grouped
// from the auth log, so it needs no extra bookkeeping and covers history
// as far back as the log goes. MAC-auth devices are excluded — those live
// on the Devices / NAC tab, keyed by device rather than person.
// ---------------------------------------------------------------------------
function UserDevicesTab() {
  const [search, setSearch] = useState('');

  const { data: rows = [] } = useQuery({
    queryKey: ['radius-user-devices', search],
    queryFn:  () => api.get(`/radius/user-devices${search ? '?search='+encodeURIComponent(search) : ''}`),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
        Every device each user has authenticated with on Wi-Fi (from the auth log).
        Note: personal devices ship with per-network randomized MAC addresses, so the same
        phone shows one stable MAC per SSID — still useful for "how many devices does this
        account sign in from" and spotting shared credentials.
      </div>
      <input className={INPUT + ' !w-72 text-xs'} value={search} onChange={e=>setSearch(e.target.value)}
        placeholder="Filter by user or MAC…"/>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['User','Device MAC','SSIDs','Last VLAN','Accepted','Rejected','First seen','Last seen'].map(h=>
              <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(r=>(
              <tr key={`${r.username}|${r.mac_address}`} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-xs text-slate-700">{r.username}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.mac_address}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{(r.ssids || []).join(', ') || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.last_vlan ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-green-700">{r.accepts}</td>
                <td className="px-3 py-2 text-xs text-red-600">{r.rejects}</td>
                <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{new Date(r.first_seen).toLocaleString()}</td>
                <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{new Date(r.last_seen).toLocaleString()}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">No user authentications logged yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HA & Config Tab
// ---------------------------------------------------------------------------
function HaConfigTab() {
  const qc = useQueryClient();
  const [haForm, setHaForm] = useState(null);

  const { data: ha = {} } = useQuery({
    queryKey: ['radius-ha'],
    queryFn:  () => api.get('/radius/ha'),
    onSuccess: d => { if (!haForm) setHaForm(d); },
  });

  const saveHa = useMutation({
    mutationFn: () => api.put('/radius/ha', haForm || ha),
    onSuccess: () => qc.invalidateQueries({queryKey:['radius-ha']}),
  });

  const cfg = haForm || ha;
  const set = (k, v) => setHaForm(p => ({...(p||ha),[k]:v}));

  return (
    <div className="flex flex-col gap-6">
      {/* VRRP config */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <h3 className="font-semibold text-slate-900 mb-1">VRRP / Keepalived — Virtual IP Configuration</h3>
        <p className="text-xs text-slate-500 mb-4">
          This VIP is shared with the ClassGuard web UI — it can also be configured from{' '}
          <a href="/admin/ha" className="text-primary-600 underline">HA Cluster</a>, including failover health checks.
        </p>
        <div className="grid md:grid-cols-3 gap-4">
          <Field label="Virtual IP Address (VIP)" hint="shared between nodes">
            <input className={INPUT} value={cfg.vip_address||''} onChange={e=>set('vip_address',e.target.value)} placeholder="172.16.1.249"/>
          </Field>
          <Field label="Subnet prefix length">
            <input type="number" className={INPUT} value={cfg.vip_prefix_len||24} onChange={e=>set('vip_prefix_len',parseInt(e.target.value))} min={1} max={32}/>
          </Field>
          <Field label="Network interface" hint="on every node">
            <input className={INPUT} value={cfg.vip_interface||'eth0'} onChange={e=>set('vip_interface',e.target.value)}/>
          </Field>
          <Field label="VRRP instance name">
            <input className={INPUT} value={cfg.vrrp_instance_name||'CLASSGUARD_APPS'} onChange={e=>set('vrrp_instance_name',e.target.value)}/>
          </Field>
          <Field label="Virtual Router ID" hint="51–254, unique per VIP">
            <input type="number" className={INPUT} value={cfg.vrrp_virtual_router_id||51} onChange={e=>set('vrrp_virtual_router_id',parseInt(e.target.value))} min={1} max={255}/>
          </Field>
          <Field label="VRRP auth password" hint={ha.vrrp_auth_password_set ? 'set — leave blank to keep' : undefined}>
            <input type="password" className={INPUT} value={cfg.vrrp_auth_password||''} onChange={e=>set('vrrp_auth_password',e.target.value)} placeholder={ha.vrrp_auth_password_set ? '••••••••' : ''}/>
          </Field>
        </div>
        <div className="mt-4 pt-4 border-t border-slate-100">
          <FailoverPriorityList />
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={()=>saveHa.mutate()} disabled={saveHa.isPending} className="btn-primary text-sm">
            {saveHa.isPending?'Saving…':'Save VIP Config'}
          </button>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
        Looking for Google Secure LDAP setup? It moved to{' '}
        <a href="/admin/integrations" className="underline font-medium">Integrations → Google Workspace → Secure LDAP</a>{' '}
        — it's a Workspace-level credential other features can use too, not a RADIUS-specific one.
      </div>


      {/* Android / WiFi profile guide */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <h3 className="font-semibold text-slate-900 mb-1">Android Device Configuration</h3>
        <p className="text-xs text-slate-500 mb-3">iPhones auto-negotiate EAP-TTLS. Android requires explicit configuration — push a WiFi profile via Google Admin for managed devices, or share these manual settings for BYOD.</p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-slate-50 rounded-lg p-4 text-xs space-y-2 font-mono">
            <div className="font-sans font-semibold text-slate-700 text-sm mb-2">Managed Android (Google Admin → Devices → Networks → WiFi)</div>
            <div><span className="text-slate-500">EAP method:</span> TTLS</div>
            <div><span className="text-slate-500">Phase 2 auth:</span> PAP</div>
            <div><span className="text-slate-500">CA certificate:</span> (upload your FreeRADIUS server.crt)</div>
            <div><span className="text-slate-500">Domain:</span> your school domain</div>
            <div><span className="text-slate-500">Identity:</span> {'${USER_EMAIL}'}</div>
            <div><span className="text-slate-500">Anonymous identity:</span> anonymous</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-4 text-xs space-y-2">
            <div className="font-semibold text-slate-700 text-sm mb-2">BYOD Android (manual steps)</div>
            <ol className="list-decimal list-inside space-y-1 text-slate-600">
              <li>Settings → WiFi → (hold SSID) → Modify network</li>
              <li>Show advanced options → EAP method: TTLS</li>
              <li>Phase 2 authentication: PAP</li>
              <li>CA certificate: Use system certificates (or install your cert)</li>
              <li>Domain / Online certificate status: your server hostname</li>
              <li>Identity: full email (user@school.edu)</li>
              <li>Password: Google Workspace password</li>
            </ol>
            <div className="text-slate-400 mt-2">No MSCHAPv2 needed — PAP inside TLS is fully compatible with Google passwords.</div>
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
        FreeRADIUS and Keepalived configs are auto-generated from the settings above and applied on each node by the update-watcher every minute — no manual steps needed.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// UniFi Setup Tab
// Wires ClassGuard into the UniFi controller as its RADIUS server: one
// "ClassGuard" RADIUS profile shared by every WLAN, then per-WLAN switches
// for 802.1X (BYOD) or PSK + MAC auth (corporate NAC). All buttons push a
// change to the live controller immediately, hence the confirm()s.
// ---------------------------------------------------------------------------
const MAC_FORMAT_LABELS = {
  none_lower:   'aabbccddeeff',
  hyphen_lower: 'aa-bb-cc-dd-ee-ff',
  colon_lower:  'aa:bb:cc:dd:ee:ff',
  none_upper:   'AABBCCDDEEFF',
  hyphen_upper: 'AA-BB-CC-DD-EE-FF',
  colon_upper:  'AA:BB:CC:DD:EE:FF',
};

function SecurityBadge({ security }) {
  const map = {
    wpaeap: { cls: 'bg-indigo-100 text-indigo-700', label: '802.1X (Enterprise)' },
    wpapsk: { cls: 'bg-slate-100 text-slate-600',   label: 'WPA-PSK' },
    open:   { cls: 'bg-amber-100 text-amber-700',   label: 'Open' },
  };
  const s = map[security] || { cls: 'bg-slate-100 text-slate-500', label: security };
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${s.cls}`}>{s.label}</span>;
}

function UnifiTab() {
  const qc = useQueryClient();
  const [macFormat, setMacFormat] = useState('none_lower');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['radius-unifi-setup'],
    queryFn:  () => api.get('/radius/unifi/setup'),
    retry: false,
    staleTime: 30_000,
  });

  const invalidate = () => qc.invalidateQueries({queryKey:['radius-unifi-setup']});
  const profileMut = useMutation({
    mutationFn: () => api.post('/radius/unifi/profile', {}),
    onSuccess: invalidate,
  });
  const wlanMut = useMutation({
    mutationFn: ({ id, action }) => api.put(`/radius/unifi/wlans/${id}`, { action, mac_format: macFormat }),
    onSuccess: invalidate,
  });

  if (isLoading) return <p className="text-sm text-slate-400">Contacting UniFi controller…</p>;
  if (error) return (
    <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
      {error.message || 'Could not reach the UniFi controller'}
      <button onClick={()=>refetch()} className="ml-3 underline">Retry</button>
    </div>
  );
  if (!data.configured) return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
      No active UniFi controller — add one under Admin → Integrations → Network first.
    </div>
  );

  const cg = data.classguard_profile;
  const anyMutErr = profileMut.error || wlanMut.error;

  // Districts typically have one WLAN entry per building/AP-group sharing the
  // same SSID name — group them so "Devices ×8" reads as one network.
  const groups = [];
  for (const w of data.wlans) {
    const g = groups.find(g => g.name === w.name);
    if (g) g.wlans.push(w); else groups.push({ name: w.name, wlans: [w] });
  }

  const applyAll = async (wlans, action, label) => {
    if (!confirm(`${label} for all ${wlans.length} "${wlans[0].name}" WLANs? This pushes to the UniFi controller immediately.`)) return;
    for (const w of wlans) await wlanMut.mutateAsync({ id: w._id, action });
  };

  return (
    <div className="flex flex-col gap-4">
      {anyMutErr && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {anyMutErr.message}
        </div>
      )}

      {/* RADIUS profile card */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-900 text-sm">ClassGuard RADIUS profile</h3>
            <p className="text-xs text-slate-500 mt-1">
              One profile serves both networks — BYOD WLANs use it for 802.1X, corporate WLANs for MAC auth.
              Auth/accounting point at the RADIUS virtual IP <span className="font-mono">{data.radius_server.ip || 'not set'}</span> with
              the shared NAS secret{data.radius_server.secret_set ? '' : ' (NOT SET — fix in HA & Config first)'}.
            </p>
            {cg ? (
              <div className="mt-2 text-xs text-slate-600 flex flex-wrap gap-3">
                <span>Auth: <span className="font-mono">{cg.auth_servers.map(s=>`${s.ip}:${s.port}`).join(', ') || '—'}</span></span>
                <span>Accounting: {cg.accounting_enabled ? 'on' : 'off'}</span>
                <span>RADIUS-assigned VLAN: {cg.vlan_enabled ? cg.vlan_wlan_mode : 'disabled'}</span>
              </div>
            ) : (
              <p className="mt-2 text-xs text-amber-700">Profile doesn't exist in the controller yet.</p>
            )}
          </div>
          <button
            onClick={()=>{ if (confirm(`${cg ? 'Update' : 'Create'} the "ClassGuard" RADIUS profile on the UniFi controller?`)) profileMut.mutate(); }}
            disabled={profileMut.isPending || !data.radius_server.ip || !data.radius_server.secret_set}
            className="flex-shrink-0 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50">
            {profileMut.isPending ? 'Pushing…' : cg ? 'Update profile' : 'Create profile'}
          </button>
        </div>
      </div>

      {/* How VLANs behave */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
        <strong>How VLANs behave:</strong> the profile is created with RADIUS-assigned VLAN set to <em>optional</em> —
        when a Wi-Fi Policy assigns a VLAN (BYOD), the client lands on it at every building, so their subnet follows them.
        When ClassGuard sends no VLAN (corporate MAC auth), the client stays on the WLAN's own per-building network,
        so a device moving between buildings picks up that building's corporate subnet automatically.
      </div>

      {/* MAC format */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
        <div className="flex-1">
          <h3 className="font-semibold text-slate-900 text-sm">MAC Address Format</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Applied when enabling MAC auth below. ClassGuard accepts every format, so this only affects how MACs look in controller logs.
          </p>
        </div>
        <div className="w-56 flex-shrink-0">
          <select className={SELECT + ' font-mono'} value={macFormat} onChange={e=>setMacFormat(e.target.value)}>
            {(data.mac_formats || Object.keys(MAC_FORMAT_LABELS)).map(f=>(
              <option key={f} value={f}>{MAC_FORMAT_LABELS[f] || f}</option>
            ))}
          </select>
        </div>
      </div>

      {/* WLANs */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-2">WLAN</th>
              <th className="px-4 py-2">Security</th>
              <th className="px-4 py-2">MAC auth</th>
              <th className="px-4 py-2">RADIUS profile</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => g.wlans.map((w, i) => (
              <tr key={w._id} className={`border-t border-slate-100 ${!w.enabled ? 'opacity-40' : ''}`}>
                <td className="px-4 py-2 font-medium text-slate-800">
                  {i === 0 ? g.name : <span className="text-slate-300 pl-3">└</span>}
                  {i === 0 && g.wlans.length > 1 && <span className="ml-2 text-xs text-slate-400">×{g.wlans.length} (per building)</span>}
                  {!w.enabled && <span className="ml-2 text-xs text-slate-400">disabled</span>}
                </td>
                <td className="px-4 py-2"><SecurityBadge security={w.security}/></td>
                <td className="px-4 py-2 text-xs">
                  {w.macauth_enabled
                    ? <span className="text-green-700 font-semibold">on <span className="font-mono font-normal text-slate-400">({MAC_FORMAT_LABELS[w.radius_mac_auth_format] || w.radius_mac_auth_format})</span></span>
                    : <span className="text-slate-400">off</span>}
                </td>
                <td className="px-4 py-2 text-xs">
                  {w.uses_classguard
                    ? <span className="text-green-700 font-semibold">ClassGuard</span>
                    : w.radiusprofile_id
                      ? <span className="text-slate-500">{(data.other_profiles.find(p=>p._id===w.radiusprofile_id)||{}).name || 'other'}</span>
                      : <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {w.security === 'wpapsk' && !w.macauth_enabled && (
                    <button disabled={!cg || wlanMut.isPending}
                      onClick={()=>{ if (i === 0 && g.wlans.length > 1) { applyAll(g.wlans.filter(x=>x.security==='wpapsk' && !x.macauth_enabled), 'enable_macauth', 'Enable MAC auth'); } else if (confirm(`Enable MAC auth on "${w.name}"? Unapproved devices will be kicked off this WLAN.`)) wlanMut.mutate({ id: w._id, action: 'enable_macauth' }); }}
                      className="text-xs font-medium text-primary-700 hover:underline disabled:opacity-40 disabled:no-underline mr-3"
                      title={!cg ? 'Create the ClassGuard profile first' : undefined}>
                      {i === 0 && g.wlans.length > 1 ? 'Add MAC auth (all)' : 'Add MAC auth'}
                    </button>
                  )}
                  {w.macauth_enabled && (
                    <button disabled={wlanMut.isPending}
                      onClick={()=>{ if (confirm(`Disable MAC auth on "${w.name}"?`)) wlanMut.mutate({ id: w._id, action: 'disable_macauth' }); }}
                      className="text-xs font-medium text-red-600 hover:underline disabled:opacity-40 mr-3">
                      Remove MAC auth
                    </button>
                  )}
                  {w.security === 'wpaeap' && !w.uses_classguard && (
                    <button disabled={!cg || wlanMut.isPending}
                      onClick={()=>{ if (i === 0 && g.wlans.length > 1) { applyAll(g.wlans.filter(x=>x.security==='wpaeap' && !x.uses_classguard), 'enable_byod', 'Point 802.1X at ClassGuard'); } else if (confirm(`Point "${w.name}" 802.1X at ClassGuard? Every client on it will re-authenticate against ClassGuard.`)) wlanMut.mutate({ id: w._id, action: 'enable_byod' }); }}
                      className="text-xs font-medium text-primary-700 hover:underline disabled:opacity-40 disabled:no-underline"
                      title={!cg ? 'Create the ClassGuard profile first' : undefined}>
                      {i === 0 && g.wlans.length > 1 ? 'Use ClassGuard (all)' : 'Use ClassGuard'}
                    </button>
                  )}
                </td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TABS = ['Overview','NAS Clients','Devices / NAC','Wi-Fi Policies','Auth Log','User Devices','UniFi Setup','HA & Config'];

export default function RadiusPage() {
  const [tab, setTab] = useState('Overview');

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">RADIUS / NAC</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          FreeRADIUS integration — WiFi authentication, device access control, and HA failover
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-5">
        {TABS.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors
              ${tab===t?'bg-white border border-b-white border-slate-200 text-primary-700 -mb-px':'text-slate-500 hover:text-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab==='Overview'     && <OverviewTab/>}
      {tab==='NAS Clients'  && <NasTab/>}
      {tab==='Devices / NAC' && <DevicesTab/>}
      {tab==='Wi-Fi Policies' && <PoliciesTab/>}
      {tab==='Auth Log'     && <LogTab/>}
      {tab==='User Devices' && <UserDevicesTab/>}
      {tab==='UniFi Setup'  && <UnifiTab/>}
      {tab==='HA & Config'  && <HaConfigTab/>}
    </div>
  );
}
