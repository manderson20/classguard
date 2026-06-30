import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-xl shadow-xl ${wide ? 'w-full max-w-2xl' : 'w-full max-w-lg'} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      <span>{label}{hint && <span className="text-slate-400 font-normal ml-1">({hint})</span>}</span>
      {children}
    </label>
  );
}

const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const TABS = ['Phones', 'Caller ID', 'DID Numbers', 'Ring Groups', 'Paging Groups', 'Parking Lots', 'Extension Rules', 'Change Workflow'];

async function downloadFile(path, filename) {
  const token = localStorage.getItem('cg_token');
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { alert('Download failed'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

const downloadDirectory = () => downloadFile('/api/v1/phones/directory.docx', 'Phone Directory.docx');
const downloadTemplate  = () => downloadFile('/api/v1/phones/template.xlsx', 'ClassGuard Phone System Template.xlsx');

// ---------------------------------------------------------------------------
// Generic template import — preview (server rolls back) then explicit
// commit. Distinct from the original district-specific spreadsheet importer
// (still available server-side, just no longer surfaced here) — this one
// understands the clean, reusable "Download Template" format any district's
// data can be entered into.
// ---------------------------------------------------------------------------
function ImportModal({ onClose, onCommitted }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [committed, setCommitted] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send(commit) {
    setBusy(true);
    setError('');
    try {
      const token = localStorage.getItem('cg_token');
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/v1/phones/import-template?commit=${commit}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      if (commit) { setCommitted(data); onCommitted(); } else { setPreview(data); }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const c = (committed || preview)?.counts;

  return (
    <Modal title="Import Phone System Template" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-600">
          Upload a filled-in copy of the template (use "Download Template" if you don't have one yet). Re-importing
          later updates existing records (matched by Device ID / Extension / Phone Number etc.) rather than duplicating them.
        </p>
        {!committed && (
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-xl p-8 cursor-pointer hover:border-primary-400 transition-colors">
            <span className="text-sm font-medium text-slate-600">{file ? file.name : 'Click to upload filled-in template'}</span>
            <input type="file" accept=".xlsx" className="hidden" onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null); setError(''); }} />
          </label>
        )}
        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded p-2">{error}</div>}
        {c && (
          <div className={`rounded-lg p-4 border ${committed ? 'bg-green-50 border-green-200' : 'bg-blue-50 border-blue-200'}`}>
            <p className="text-sm font-semibold text-slate-800 mb-2">{committed ? 'Import complete' : 'Preview — nothing has been saved yet'}</p>
            <div className="grid grid-cols-2 gap-2 text-sm text-slate-700">
              <div>Phones: <strong>{c.phones}</strong></div>
              <div>Caller ID profiles: <strong>{c.caller_id_profiles}</strong></div>
              <div>DID numbers: <strong>{c.did_numbers}</strong></div>
              <div>Ring groups: <strong>{c.ring_groups}</strong></div>
              <div>Paging groups: <strong>{c.paging_groups}</strong></div>
              <div>Parking lots: <strong>{c.parking_lots}</strong></div>
              <div>Extension rules: <strong>{c.extension_rules}</strong></div>
            </div>
            {(preview || committed).warnings?.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold text-amber-700 mb-1">{(preview || committed).warnings.length} note(s):</p>
                <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                  {(preview || committed).warnings.slice(0, 10).map((w, i) => <li key={i} className="text-xs text-amber-600 font-mono">{w}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="btn-secondary text-sm">{committed ? 'Close' : 'Cancel'}</button>
        {!committed && <button onClick={() => send(false)} disabled={!file || busy} className="btn-secondary text-sm">{busy ? 'Previewing…' : 'Preview'}</button>}
        {!committed && preview && (
          <button
            onClick={() => { if (confirm('This will create/update the records shown in the preview. Continue?')) send(true); }}
            disabled={busy} className="btn-primary text-sm">
            {busy ? 'Importing…' : 'Confirm Import'}
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Directory settings — multi-line "middle title" shown centered in the
// generated directory's header, between the district name and rev date.
// ---------------------------------------------------------------------------
function DirectorySettingsModal({ onClose }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['phone-directory-settings'], queryFn: () => api.get('/phones/directory-settings') });
  const [title, setTitle] = useState(null);

  const save = useMutation({
    mutationFn: () => api.put('/phones/directory-settings', { middle_title: title }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['phone-directory-settings'] }); onClose(); },
  });

  const value = title ?? data?.middle_title ?? '';

  return (
    <Modal title="Directory Title" onClose={onClose}>
      <p className="text-xs text-slate-500 mb-2">
        Shown centered in the directory header. One line per row — use <code>{'{year}'}</code> to insert the school year (e.g. 2026-2027).
      </p>
      <textarea className={INPUT} rows={4} value={value} onChange={e => setTitle(e.target.value)}
        placeholder={'Your District Schools\n{year} Phone Directory'} />
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Phones tab — full CRUD
// ---------------------------------------------------------------------------
const EMPTY_PHONE = {
  device_id: '', device_type: '', mac_address: '', ip_address: '', network_switch: '', switch_interface: '',
  building: '', room_number: '', extension: '', display_name: '', voicemail_email: '', leave_voicemail_on_server: '',
  egress_outside_number: '', outbound_egress_cid: '', ingress_phone_number: '', emergency_egress_cid: '', notes: '',
  include_in_directory: true,
};

const PHONE_COLUMNS = [
  { key: 'extension',       label: 'Extension',  mono: true },
  { key: 'display_name',    label: 'Name' },
  { key: 'building',        label: 'Building' },
  { key: 'room_number',     label: 'Room' },
  { key: 'device_type',     label: 'Device' },
  { key: 'ip_address',      label: 'IP', mono: true },
  { key: 'mac_address',     label: 'MAC', mono: true },
  { key: 'network_switch',  label: 'Switch' },
  { key: 'switch_interface',label: 'Switch Port' },
  { key: 'voicemail_email', label: 'Voicemail Email' },
  { key: 'include_in_directory', label: 'In Directory', render: v => v === false ? 'No' : 'Yes' },
  { key: 'is_active',       label: 'Active', render: v => v === false ? 'No' : 'Yes' },
  { key: 'notes',           label: 'Notes' },
];
const DEFAULT_VISIBLE_COLUMNS = ['extension', 'display_name', 'building', 'room_number', 'device_type', 'ip_address', 'include_in_directory'];

function useStickyState(key, initial) {
  const [state, setState] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : initial;
    } catch { return initial; }
  });
  const set = v => { setState(v); try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };
  return [state, set];
}

function ColumnPicker({ visible, setVisible }) {
  const [open, setOpen] = useState(false);
  const toggle = key => setVisible(visible.includes(key) ? visible.filter(k => k !== key) : [...visible, key]);

  return (
    <div className="relative">
      <button className="btn-secondary text-sm" onClick={() => setOpen(o => !o)}>Columns ▾</button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-lg p-2 w-56 max-h-80 overflow-y-auto">
            {PHONE_COLUMNS.map(c => (
              <label key={c.key} className="flex items-center gap-2 px-2 py-1 text-sm text-slate-700 hover:bg-slate-50 rounded cursor-pointer">
                <input type="checkbox" checked={visible.includes(c.key)} onChange={() => toggle(c.key)} className="w-4 h-4 rounded" />
                {c.label}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PhonesTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_PHONE);
  const [visibleColumns, setVisibleColumns] = useStickyState('cg_phones_columns', DEFAULT_VISIBLE_COLUMNS);
  const [sort, setSort] = useStickyState('cg_phones_sort', { key: 'extension', dir: 'asc' });

  const { data: phones = [] } = useQuery({
    queryKey: ['phones', search],
    queryFn: () => api.get(`/phones/phones${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  });

  const save = useMutation({
    mutationFn: () => modal === 'add' ? api.post('/phones/phones', form) : api.put(`/phones/phones/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['phones'] }); setModal(null); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/phones/phones/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['phones'] }),
  });
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const columns = PHONE_COLUMNS.filter(c => visibleColumns.includes(c.key));
  const sorted = [...phones].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  const toggleSort = key => setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });

  return (
    <>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <input className={`${INPUT} w-64`} placeholder="Search name, extension, building…" value={search} onChange={e => setSearch(e.target.value)} />
        <ColumnPicker visible={visibleColumns} setVisible={setVisibleColumns} />
        <button className="btn-primary text-sm ml-auto" onClick={() => { setForm(EMPTY_PHONE); setModal('add'); }}>+ Add Phone</button>
      </div>
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              {columns.map(c => (
                <th key={c.key} className="text-left px-3 py-2 cursor-pointer hover:text-slate-700 whitespace-nowrap" onClick={() => toggleSort(c.key)}>
                  {c.label}{sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map(p => (
              <tr key={p.id} className="hover:bg-slate-50">
                {columns.map(c => (
                  <td key={c.key} className={`px-3 py-2 ${c.mono ? 'font-mono' : ''} ${c.key !== 'display_name' && c.key !== 'extension' ? 'text-slate-500' : ''}`}>
                    {c.render ? c.render(p[c.key], p) : p[c.key]}
                  </td>
                ))}
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button className="text-primary-600 hover:underline mr-3" onClick={() => { setForm({ ...EMPTY_PHONE, ...p }); setModal(p); }}>Edit</button>
                  <button className="text-red-600 hover:underline" onClick={() => { if (confirm(`Delete phone ${p.device_id}?`)) del.mutate(p.id); }}>Delete</button>
                </td>
              </tr>
            ))}
            {phones.length === 0 && <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-slate-400">No phones yet — download the template or add one.</td></tr>}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal title={modal === 'add' ? 'Add Phone' : `Edit ${modal.device_id}`} onClose={() => setModal(null)} wide>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Device ID"><input className={INPUT} value={form.device_id} onChange={e => setF('device_id', e.target.value)} disabled={modal !== 'add'} /></Field>
            <Field label="Device Type"><input className={INPUT} value={form.device_type || ''} onChange={e => setF('device_type', e.target.value)} /></Field>
            <Field label="Extension"><input className={INPUT} value={form.extension || ''} onChange={e => setF('extension', e.target.value)} /></Field>
            <Field label="Display Name"><input className={INPUT} value={form.display_name || ''} onChange={e => setF('display_name', e.target.value)} /></Field>
            <Field label="Building"><input className={INPUT} value={form.building || ''} onChange={e => setF('building', e.target.value)} /></Field>
            <Field label="Room Number"><input className={INPUT} value={form.room_number || ''} onChange={e => setF('room_number', e.target.value)} /></Field>
            <Field label="IP Address"><input className={INPUT} value={form.ip_address || ''} onChange={e => setF('ip_address', e.target.value)} /></Field>
            <Field label="MAC Address"><input className={INPUT} value={form.mac_address || ''} onChange={e => setF('mac_address', e.target.value)} /></Field>
            <Field label="Network Switch"><input className={INPUT} value={form.network_switch || ''} onChange={e => setF('network_switch', e.target.value)} /></Field>
            <Field label="Switch Interface"><input className={INPUT} value={form.switch_interface || ''} onChange={e => setF('switch_interface', e.target.value)} /></Field>
            <Field label="Voicemail Email"><input className={INPUT} value={form.voicemail_email || ''} onChange={e => setF('voicemail_email', e.target.value)} /></Field>
            <Field label="Egress Outside Number"><input className={INPUT} value={form.egress_outside_number || ''} onChange={e => setF('egress_outside_number', e.target.value)} /></Field>
            <Field label="Outbound Egress CID"><input className={INPUT} value={form.outbound_egress_cid || ''} onChange={e => setF('outbound_egress_cid', e.target.value)} /></Field>
            <Field label="Ingress Phone Number"><input className={INPUT} value={form.ingress_phone_number || ''} onChange={e => setF('ingress_phone_number', e.target.value)} /></Field>
            <Field label="Emergency Egress CID"><input className={INPUT} value={form.emergency_egress_cid || ''} onChange={e => setF('emergency_egress_cid', e.target.value)} /></Field>
          </div>
          <Field label="Notes"><textarea className={INPUT} rows={2} value={form.notes || ''} onChange={e => setF('notes', e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm text-slate-700 mt-3 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 rounded" checked={form.include_in_directory !== false}
              onChange={e => setF('include_in_directory', e.target.checked)} />
            Show this phone in the printed directory
            <span className="text-slate-400 text-xs">(turn off for speakers / paging-only devices)</span>
          </label>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={!form.device_id || save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Generic read+delete table for the simpler reference resources
// ---------------------------------------------------------------------------
function SimpleTable({ resource, columns, queryKey, emptyLabel }) {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: [queryKey], queryFn: () => api.get(`/phones/${resource}`) });
  const del = useMutation({
    mutationFn: id => api.delete(`/phones/${resource}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [queryKey] }),
  });

  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
          <tr>
            {columns.map(c => <th key={c.key} className="text-left px-3 py-2">{c.label}</th>)}
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map(row => (
            <tr key={row.id} className="hover:bg-slate-50">
              {columns.map(c => (
                <td key={c.key} className={`px-3 py-2 ${c.mono ? 'font-mono' : ''}`}>
                  {c.render ? c.render(row[c.key], row) : row[c.key]}
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                <button className="text-red-600 hover:underline" onClick={() => { if (confirm('Delete this row?')) del.mutate(row.id); }}>Delete</button>
              </td>
            </tr>
          ))}
          {data.length === 0 && <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-slate-400">{emptyLabel}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paging Groups — full CRUD, multicast address/VLAN picked from IPAM's
// multicast_groups (so the network side is managed in one place, not just
// populated by the one-time import).
// ---------------------------------------------------------------------------
const EMPTY_PAGING_GROUP = { page_extension: '', description: '', polycom_group_label: '', multicast_group_id: '', notes: '' };

function PagingGroupsTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_PAGING_GROUP);

  const { data: groups = [] } = useQuery({ queryKey: ['phone-paging-groups'], queryFn: () => api.get('/phones/paging-groups') });
  const { data: multicastGroups = [] } = useQuery({ queryKey: ['ipam-multicast'], queryFn: () => api.get('/ipam/multicast') });

  const save = useMutation({
    mutationFn: () => modal === 'add' ? api.post('/phones/paging-groups', form) : api.put(`/phones/paging-groups/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['phone-paging-groups'] }); setModal(null); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/phones/paging-groups/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['phone-paging-groups'] }),
  });
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  return (
    <>
      <div className="flex justify-end mb-3">
        <button className="btn-primary text-sm" onClick={() => { setForm(EMPTY_PAGING_GROUP); setModal('add'); }}>+ Add Paging Group</button>
      </div>
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Page Extension</th>
              <th className="text-left px-3 py-2">Description</th>
              <th className="text-left px-3 py-2">Group Label</th>
              <th className="text-left px-3 py-2">Multicast (IPAM)</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {groups.map(g => (
              <tr key={g.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono">{g.page_extension}</td>
                <td className="px-3 py-2">{g.description}</td>
                <td className="px-3 py-2 text-slate-500">{g.polycom_group_label}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">
                  {g.group_address ? `${g.group_address}${g.multicast_port ? `:${g.multicast_port}` : ''}` : <span className="text-slate-300">not linked</span>}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button className="text-primary-600 hover:underline mr-3" onClick={() => { setForm({ ...EMPTY_PAGING_GROUP, ...g, multicast_group_id: g.multicast_group_id || '' }); setModal(g); }}>Edit</button>
                  <button className="text-red-600 hover:underline" onClick={() => { if (confirm(`Delete paging group ${g.page_extension}?`)) del.mutate(g.id); }}>Delete</button>
                </td>
              </tr>
            ))}
            {groups.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No paging groups yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal title={modal === 'add' ? 'Add Paging Group' : `Edit ${modal.page_extension}`} onClose={() => setModal(null)}>
          <div className="flex flex-col gap-3">
            <Field label="Page Extension"><input className={INPUT} value={form.page_extension} onChange={e => setF('page_extension', e.target.value)} /></Field>
            <Field label="Description"><input className={INPUT} value={form.description || ''} onChange={e => setF('description', e.target.value)} /></Field>
            <Field label="Polycom Group Label"><input className={INPUT} value={form.polycom_group_label || ''} onChange={e => setF('polycom_group_label', e.target.value)} /></Field>
            <Field label="Multicast Group (IPAM)" hint="Network-side address/VLAN — managed in IPAM, linked here">
              <select className={INPUT} value={form.multicast_group_id || ''} onChange={e => setF('multicast_group_id', e.target.value || null)}>
                <option value="">— not linked —</option>
                {multicastGroups.map(m => (
                  <option key={m.id} value={m.id}>{m.name} ({m.group_address}{m.port ? `:${m.port}` : ''})</option>
                ))}
              </select>
            </Field>
            <Field label="Notes"><textarea className={INPUT} rows={2} value={form.notes || ''} onChange={e => setF('notes', e.target.value)} /></Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={!form.page_extension || save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Change Workflow — track extension/room reassignments per move period (e.g.
// "Summer 2026"). Each change carries its own checklist (not just a rename —
// voicemail reset, user account update, etc.), built from a reusable
// template or ad-hoc, checked off independently of the others.
// ---------------------------------------------------------------------------
const STATUS_BADGE = {
  pending:     'bg-slate-100 text-slate-600',
  in_progress: 'bg-amber-100 text-amber-700',
  completed:   'bg-green-100 text-green-700',
  cancelled:   'bg-red-50 text-red-500',
};

function NewPeriodModal({ onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', start_date: '', end_date: '', notes: '' });
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const save = useMutation({
    mutationFn: () => api.post('/phones/change-periods', form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['phone-change-periods'] }); onClose(); },
  });
  return (
    <Modal title="New Change Period" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name" hint='e.g. "Summer 2026"'><input className={INPUT} value={form.name} onChange={e => setF('name', e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start Date"><input type="date" className={INPUT} value={form.start_date} onChange={e => setF('start_date', e.target.value)} /></Field>
          <Field label="End Date"><input type="date" className={INPUT} value={form.end_date} onChange={e => setF('end_date', e.target.value)} /></Field>
        </div>
        <Field label="Notes"><textarea className={INPUT} rows={2} value={form.notes} onChange={e => setF('notes', e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button onClick={() => save.mutate()} disabled={!form.name || save.isPending} className="btn-primary text-sm">
          {save.isPending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Modal>
  );
}

function ManageTemplatesModal({ onClose }) {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({ queryKey: ['phone-change-templates'], queryFn: () => api.get('/phones/change-task-templates') });
  const [name, setName] = useState('');
  const [itemsText, setItemsText] = useState('');

  const create = useMutation({
    mutationFn: () => api.post('/phones/change-task-templates', { name, items: itemsText.split('\n').map(s => s.trim()).filter(Boolean) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['phone-change-templates'] }); setName(''); setItemsText(''); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/phones/change-task-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['phone-change-templates'] }),
  });

  return (
    <Modal title="Manage Task Checklists" onClose={onClose} wide>
      <div className="flex flex-col gap-3 mb-5">
        {templates.map(t => (
          <div key={t.id} className="border border-slate-200 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <strong className="text-sm text-slate-800">{t.name}</strong>
              <button className="text-red-600 hover:underline text-xs" onClick={() => { if (confirm(`Delete "${t.name}"?`)) del.mutate(t.id); }}>Delete</button>
            </div>
            <ul className="text-xs text-slate-500 list-disc pl-4">
              {t.items.map(i => <li key={i.id}>{i.label}</li>)}
            </ul>
          </div>
        ))}
        {templates.length === 0 && <p className="text-sm text-slate-400">No checklist templates yet.</p>}
      </div>
      <div className="border-t border-slate-200 pt-4">
        <p className="text-sm font-semibold text-slate-800 mb-2">New checklist template</p>
        <Field label="Name" hint='e.g. "Standard Teacher Move"'><input className={INPUT} value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Tasks" hint="one per line">
          <textarea className={INPUT} rows={5} value={itemsText} onChange={e => setItemsText(e.target.value)}
            placeholder={'Update display name / caller ID\nReset voicemail box\nUpdate user account login'} />
        </Field>
        <div className="flex justify-end mt-3">
          <button onClick={() => create.mutate()} disabled={!name || !itemsText.trim() || create.isPending} className="btn-primary text-sm">
            {create.isPending ? 'Creating…' : 'Create Template'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewChangeModal({ periodId, onClose }) {
  const qc = useQueryClient();
  const { data: phones = [] } = useQuery({ queryKey: ['phones', ''], queryFn: () => api.get('/phones/phones') });
  const { data: templates = [] } = useQuery({ queryKey: ['phone-change-templates'], queryFn: () => api.get('/phones/change-task-templates') });
  const [form, setForm] = useState({
    phone_id: '', extension: '', building: '', room_number: '',
    previous_occupant: '', new_occupant: '', notes: '', template_id: '',
  });
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const create = useMutation({
    mutationFn: () => api.post(`/phones/change-periods/${periodId}/changes`, { ...form, phone_id: form.phone_id || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['phone-changes', periodId] }); onClose(); },
  });

  const selectPhone = id => {
    const p = phones.find(x => x.id === id);
    setForm(f => ({ ...f, phone_id: id, extension: p?.extension || f.extension, building: p?.building || f.building, room_number: p?.room_number || f.room_number, previous_occupant: p?.display_name || f.previous_occupant }));
  };

  return (
    <Modal title="New Change" onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone" hint="optional — auto-fills extension/room">
          <select className={INPUT} value={form.phone_id} onChange={e => selectPhone(e.target.value)}>
            <option value="">— none —</option>
            {phones.map(p => <option key={p.id} value={p.id}>{p.extension} — {p.display_name}</option>)}
          </select>
        </Field>
        <Field label="Extension"><input className={INPUT} value={form.extension} onChange={e => setF('extension', e.target.value)} /></Field>
        <Field label="Building"><input className={INPUT} value={form.building} onChange={e => setF('building', e.target.value)} /></Field>
        <Field label="Room Number"><input className={INPUT} value={form.room_number} onChange={e => setF('room_number', e.target.value)} /></Field>
        <Field label="Previous Occupant"><input className={INPUT} value={form.previous_occupant} onChange={e => setF('previous_occupant', e.target.value)} /></Field>
        <Field label="New Occupant"><input className={INPUT} value={form.new_occupant} onChange={e => setF('new_occupant', e.target.value)} /></Field>
      </div>
      <Field label="Checklist" hint="pre-fills tasks below; you can add more after creating">
        <select className={INPUT} value={form.template_id} onChange={e => setF('template_id', e.target.value)}>
          <option value="">— none / build custom after creating —</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.items.length} tasks)</option>)}
        </select>
      </Field>
      <Field label="Notes"><textarea className={INPUT} rows={2} value={form.notes} onChange={e => setF('notes', e.target.value)} /></Field>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button onClick={() => create.mutate()} disabled={create.isPending} className="btn-primary text-sm">
          {create.isPending ? 'Creating…' : 'Create Change'}
        </button>
      </div>
    </Modal>
  );
}

function ChangeRow({ change, periodId }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [newTask, setNewTask] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['phone-changes', periodId] });

  const toggleTask = useMutation({
    mutationFn: ({ id, is_done }) => api.put(`/phones/change-tasks/${id}`, { is_done }),
    onSuccess: invalidate,
  });
  const addTask = useMutation({
    mutationFn: label => api.post(`/phones/changes/${change.id}/tasks`, { label }),
    onSuccess: () => { invalidate(); setNewTask(''); },
  });
  const setStatus = useMutation({
    mutationFn: status => api.put(`/phones/changes/${change.id}`, { ...change, status }),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: () => api.delete(`/phones/changes/${change.id}`),
    onSuccess: invalidate,
  });

  const doneCount = change.tasks.filter(t => t.is_done).length;

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50" onClick={() => setExpanded(e => !e)}>
        <span className="text-slate-400 text-xs w-3">{expanded ? '▼' : '▶'}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-800">
            {change.building}{change.room_number ? ` / ${change.room_number}` : ''} {change.extension && <span className="font-mono text-slate-500">— {change.extension}</span>}
          </div>
          <div className="text-xs text-slate-500">
            {change.previous_occupant || '—'} → {change.new_occupant || '—'}
            {change.tasks.length > 0 && <span className="ml-2 text-slate-400">{doneCount}/{change.tasks.length} tasks</span>}
          </div>
        </div>
        <select
          className={`text-xs font-medium rounded px-2 py-1 border-0 ${STATUS_BADGE[change.status] || STATUS_BADGE.pending}`}
          value={change.status} onClick={e => e.stopPropagation()}
          onChange={e => setStatus.mutate(e.target.value)}>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button className="text-red-500 hover:underline text-xs" onClick={e => { e.stopPropagation(); if (confirm('Delete this change?')) del.mutate(); }}>Delete</button>
      </div>
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-3 bg-slate-50">
          {change.notes && <p className="text-xs text-slate-500 mb-2 italic">{change.notes}</p>}
          <ul className="flex flex-col gap-1 mb-3">
            {change.tasks.map(t => (
              <li key={t.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="w-4 h-4 rounded" checked={t.is_done}
                  onChange={e => toggleTask.mutate({ id: t.id, is_done: e.target.checked })} />
                <span className={t.is_done ? 'text-slate-400 line-through' : 'text-slate-700'}>{t.label}</span>
              </li>
            ))}
            {change.tasks.length === 0 && <li className="text-xs text-slate-400">No tasks yet.</li>}
          </ul>
          <div className="flex gap-2">
            <input className={INPUT + ' text-xs'} placeholder="Add a task…" value={newTask}
              onChange={e => setNewTask(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && newTask.trim()) addTask.mutate(newTask.trim()); }} />
            <button className="btn-secondary text-xs" disabled={!newTask.trim()} onClick={() => addTask.mutate(newTask.trim())}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChangePeriodDetail({ period, onBack }) {
  const [showNewChange, setShowNewChange] = useState(false);
  const { data: changes = [] } = useQuery({
    queryKey: ['phone-changes', period.id],
    queryFn: () => api.get(`/phones/change-periods/${period.id}/changes`),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <button className="text-xs text-primary-600 hover:underline mb-1" onClick={onBack}>← All periods</button>
          <h2 className="font-bold text-slate-900">{period.name}</h2>
          {period.notes && <p className="text-xs text-slate-500">{period.notes}</p>}
        </div>
        <button className="btn-primary text-sm" onClick={() => setShowNewChange(true)}>+ New Change</button>
      </div>
      <div className="flex flex-col gap-2">
        {changes.map(c => <ChangeRow key={c.id} change={c} periodId={period.id} />)}
        {changes.length === 0 && <p className="text-sm text-slate-400 text-center py-8">No changes yet in this period.</p>}
      </div>
      {showNewChange && <NewChangeModal periodId={period.id} onClose={() => setShowNewChange(false)} />}
    </div>
  );
}

function ChangeWorkflowTab() {
  const [selectedPeriod, setSelectedPeriod] = useState(null);
  const [showNewPeriod, setShowNewPeriod] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  const { data: periods = [] } = useQuery({ queryKey: ['phone-change-periods'], queryFn: () => api.get('/phones/change-periods') });

  if (selectedPeriod) {
    const fresh = periods.find(p => p.id === selectedPeriod.id) || selectedPeriod;
    return <ChangePeriodDetail period={fresh} onBack={() => setSelectedPeriod(null)} />;
  }

  return (
    <div>
      <div className="flex justify-end gap-2 mb-3">
        <button className="btn-secondary text-sm" onClick={() => setShowTemplates(true)}>Manage Checklists</button>
        <button className="btn-primary text-sm" onClick={() => setShowNewPeriod(true)}>+ New Period</button>
      </div>
      <div className="flex flex-col gap-2">
        {periods.map(p => (
          <div key={p.id} className="border border-slate-200 rounded-lg p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50"
            onClick={() => setSelectedPeriod(p)}>
            <div>
              <div className="font-medium text-slate-800">{p.name}</div>
              <div className="text-xs text-slate-500">
                {p.start_date ? new Date(p.start_date).toLocaleDateString() : '—'} – {p.end_date ? new Date(p.end_date).toLocaleDateString() : '—'}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-500">{p.completed_changes}/{p.total_changes} completed</span>
              <span className={`text-xs font-medium rounded px-2 py-1 ${p.status === 'closed' ? 'bg-slate-100 text-slate-500' : p.status === 'active' ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-600'}`}>
                {p.status}
              </span>
            </div>
          </div>
        ))}
        {periods.length === 0 && <p className="text-sm text-slate-400 text-center py-8">No change periods yet — create one (e.g. "Summer 2026") to start tracking moves.</p>}
      </div>
      {showNewPeriod && <NewPeriodModal onClose={() => setShowNewPeriod(false)} />}
      {showTemplates && <ManageTemplatesModal onClose={() => setShowTemplates(false)} />}
    </div>
  );
}

export default function PhoneSystemPage() {
  const [tab, setTab] = useState('Phones');
  const [importOpen, setImportOpen] = useState(false);
  const [directorySettingsOpen, setDirectorySettingsOpen] = useState(false);
  const qc = useQueryClient();

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="text-xl font-bold text-slate-900">Phone System</h1>
        <div className="flex gap-2">
          <button className="btn-secondary text-sm" onClick={downloadTemplate}>Download Template</button>
          <button className="btn-secondary text-sm" onClick={() => setImportOpen(true)}>Import Template</button>
          <button className="btn-secondary text-sm" onClick={() => setDirectorySettingsOpen(true)}>Directory Title</button>
          <button className="btn-primary text-sm" onClick={downloadDirectory}>Download Directory (.docx)</button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-4 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
              tab === t ? 'border-primary-600 text-primary-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Phones' && <PhonesTab />}
      {tab === 'Caller ID' && (
        <SimpleTable resource="caller-id-profiles" queryKey="phone-caller-id" emptyLabel="No caller ID profiles yet."
          columns={[
            { key: 'caller_id_name', label: 'Caller ID' },
            { key: 'building_department', label: 'Building/Department' },
            { key: 'phone_number', label: 'Phone', mono: true },
            { key: 'fax_number', label: 'Fax', mono: true },
            { key: 'connection_type', label: 'Connection' },
          ]} />
      )}
      {tab === 'DID Numbers' && (
        <SimpleTable resource="did-numbers" queryKey="phone-did" emptyLabel="No DID numbers yet."
          columns={[
            { key: 'phone_number', label: 'Phone Number', mono: true },
            { key: 'description', label: 'Description' },
            { key: 'number_type', label: 'Type' },
            { key: 'carrier', label: 'Carrier' },
          ]} />
      )}
      {tab === 'Ring Groups' && (
        <SimpleTable resource="ring-groups" queryKey="phone-ring-groups" emptyLabel="No ring groups yet."
          columns={[
            { key: 'extension', label: 'Extension', mono: true },
            { key: 'description', label: 'Description' },
            { key: 'members', label: 'Members', render: m => (m || []).map(x => x.description || x.extension).join(', ') },
          ]} />
      )}
      {tab === 'Paging Groups' && <PagingGroupsTab />}
      {tab === 'Parking Lots' && (
        <SimpleTable resource="parking-lots" queryKey="phone-parking-lots" emptyLabel="No parking lots yet."
          columns={[
            { key: 'location_name', label: 'Location' },
            { key: 'extension', label: 'Extension', mono: true },
            { key: 'lot_numbers', label: 'Lot Numbers', render: l => (l || []).join(', ') },
          ]} />
      )}
      {tab === 'Extension Rules' && (
        <SimpleTable resource="extension-rules" queryKey="phone-extension-rules" emptyLabel="No extension rules yet."
          columns={[
            { key: 'parent_code', label: 'Parent Code' },
            { key: 'extension_code', label: 'Extension Code', mono: true },
            { key: 'meaning', label: 'Meaning' },
          ]} />
      )}
      {tab === 'Change Workflow' && <ChangeWorkflowTab />}

      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onCommitted={() => {
            ['phones', 'phone-caller-id', 'phone-did', 'phone-ring-groups', 'phone-paging-groups', 'phone-parking-lots', 'phone-extension-rules']
              .forEach(k => qc.invalidateQueries({ queryKey: [k] }));
          }}
        />
      )}
      {directorySettingsOpen && <DirectorySettingsModal onClose={() => setDirectorySettingsOpen(false)} />}
    </div>
  );
}
