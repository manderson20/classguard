import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------
const INPUT  = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const SELECT = INPUT + ' bg-white';
const BTN    = 'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors';
const BTN_PRIMARY = BTN + ' bg-primary-600 text-white hover:bg-primary-700';
const BTN_GHOST   = BTN + ' text-slate-600 hover:bg-slate-100';
const BTN_DANGER  = BTN + ' text-red-600 hover:bg-red-50';

const RECORD_TYPES = ['A','AAAA','CNAME','MX','TXT','PTR','NS','SRV'];

const TYPE_COLOR = {
  A:     'bg-blue-100 text-blue-700',
  AAAA:  'bg-violet-100 text-violet-700',
  CNAME: 'bg-amber-100 text-amber-700',
  MX:    'bg-green-100 text-green-700',
  TXT:   'bg-slate-100 text-slate-600',
  PTR:   'bg-orange-100 text-orange-700',
  NS:    'bg-indigo-100 text-indigo-700',
  SRV:   'bg-pink-100 text-pink-700',
};

function TypeBadge({ type }) {
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-mono font-bold ${TYPE_COLOR[type] || 'bg-slate-100 text-slate-600'}`}>
      {type}
    </span>
  );
}

function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={`bg-white rounded-xl shadow-xl ${wide ? 'w-full max-w-2xl' : 'w-full max-w-md'} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone form modal
// ---------------------------------------------------------------------------
function ZoneModal({ zone, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name:        zone?.name        || '',
    type:        zone?.type        || 'forward',
    description: zone?.description || '',
    is_active:   zone?.is_active   ?? true,
  });

  const save = useMutation({
    mutationFn: () => zone
      ? api.put(`/dns/zones/${zone.id}`, form)
      : api.post('/dns/zones', form),
    onSuccess: () => { qc.invalidateQueries(['dns-zones']); onClose(); },
  });

  return (
    <Modal title={zone ? 'Edit Zone' : 'Add Zone'} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Zone Name" hint="e.g. school.local or 1.168.192.in-addr.arpa">
          <input className={INPUT} value={form.name} disabled={!!zone}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="school.local" />
        </Field>
        <Field label="Type">
          <select className={SELECT} value={form.type}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
            <option value="forward">Forward (hostname → IP)</option>
            <option value="reverse">Reverse (IP → hostname / PTR)</option>
          </select>
        </Field>
        <Field label="Description">
          <input className={INPUT} value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Optional description" />
        </Field>
        {zone && (
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={form.is_active}
              onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
            Active
          </label>
        )}
        {save.error && <p className="text-red-600 text-sm">{save.error.message}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button className={BTN_GHOST} onClick={onClose}>Cancel</button>
          <button className={BTN_PRIMARY} onClick={() => save.mutate()} disabled={!form.name || save.isPending}>
            {save.isPending ? 'Saving…' : zone ? 'Save Changes' : 'Create Zone'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Record form modal — adapts fields per record type
// ---------------------------------------------------------------------------
const RECORD_DEFAULTS = {
  name: '', type: 'A', value: '', ttl: 300,
  priority: '', weight: '', port: '', is_active: true,
};

function RecordModal({ record, zone, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(record
    ? { name: record.name, type: record.type, value: record.value, ttl: record.ttl,
        priority: record.priority ?? '', weight: record.weight ?? '', port: record.port ?? '',
        is_active: record.is_active }
    : { ...RECORD_DEFAULTS }
  );
  const f = v => setForm(p => ({ ...p, ...v }));

  const fqdn = useMemo(() => {
    if (!form.name || form.name === '@') return zone.name;
    if (form.name.endsWith('.')) return form.name.slice(0, -1);
    return `${form.name}.${zone.name}`;
  }, [form.name, zone.name]);

  const save = useMutation({
    mutationFn: () => record
      ? api.put(`/dns/records/${record.id}`, form)
      : api.post(`/dns/zones/${zone.id}/records`, form),
    onSuccess: () => { qc.invalidateQueries(['dns-records', zone.id]); onClose(); },
  });

  const needsPriority = ['MX','SRV'].includes(form.type);
  const needsSrv      = form.type === 'SRV';

  const valuePlaceholder = {
    A:     '192.168.1.10',
    AAAA:  '2001:db8::1',
    CNAME: 'other.school.local',
    MX:    'mail.school.local',
    TXT:   'v=spf1 ip4:192.168.1.0/24 ~all',
    PTR:   'server.school.local',
    NS:    'ns1.school.local',
    SRV:   'server.school.local',
  }[form.type] || '';

  const valueLabel = {
    CNAME: 'Target Hostname', MX: 'Mail Server', PTR: 'Target FQDN',
    NS: 'Nameserver', SRV: 'Target Host',
  }[form.type] || 'Value';

  return (
    <Modal title={record ? 'Edit Record' : 'Add Record'} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint={`@ = zone apex`}>
            <input className={INPUT} value={form.name}
              onChange={e => f({ name: e.target.value })}
              placeholder="@ or hostname" />
          </Field>
          <Field label="Type">
            <select className={SELECT} value={form.type}
              onChange={e => f({ type: e.target.value })}>
              {RECORD_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </Field>
        </div>

        <Field label={valueLabel} hint={`FQDN: ${fqdn}`}>
          {form.type === 'TXT' ? (
            <textarea className={INPUT + ' font-mono text-xs'} rows={3} value={form.value}
              onChange={e => f({ value: e.target.value })} placeholder={valuePlaceholder} />
          ) : (
            <input className={INPUT + ' font-mono'} value={form.value}
              onChange={e => f({ value: e.target.value })} placeholder={valuePlaceholder} />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="TTL (seconds)">
            <input className={INPUT} type="number" min={0} value={form.ttl}
              onChange={e => f({ ttl: parseInt(e.target.value) || 300 })} />
          </Field>
          {needsPriority && (
            <Field label="Priority">
              <input className={INPUT} type="number" min={0} value={form.priority}
                onChange={e => f({ priority: e.target.value ? parseInt(e.target.value) : '' })}
                placeholder={form.type === 'MX' ? '10' : '0'} />
            </Field>
          )}
        </div>

        {needsSrv && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Weight">
              <input className={INPUT} type="number" min={0} value={form.weight}
                onChange={e => f({ weight: e.target.value ? parseInt(e.target.value) : '' })}
                placeholder="0" />
            </Field>
            <Field label="Port">
              <input className={INPUT} type="number" min={0} max={65535} value={form.port}
                onChange={e => f({ port: e.target.value ? parseInt(e.target.value) : '' })}
                placeholder="443" />
            </Field>
          </div>
        )}

        {record && (
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={form.is_active}
              onChange={e => f({ is_active: e.target.checked })} />
            Active
          </label>
        )}

        {save.error && <p className="text-red-600 text-sm">{save.error.message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className={BTN_GHOST} onClick={onClose}>Cancel</button>
          <button className={BTN_PRIMARY}
            onClick={() => save.mutate()}
            disabled={!form.name || !form.value || save.isPending}>
            {save.isPending ? 'Saving…' : record ? 'Save Changes' : 'Add Record'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Records panel — right side
// ---------------------------------------------------------------------------
function RecordsPanel({ zone }) {
  const qc = useQueryClient();
  const [editRecord, setEditRecord] = useState(null);
  const [showAdd,    setShowAdd]    = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [search,     setSearch]     = useState('');

  const { data: records = [], isLoading } = useQuery({
    queryKey: ['dns-records', zone.id],
    queryFn:  () => api.get(`/dns/zones/${zone.id}/records`),
  });

  const deleteRec = useMutation({
    mutationFn: id => api.delete(`/dns/records/${id}`),
    onSuccess:  () => qc.invalidateQueries(['dns-records', zone.id]),
  });

  const filtered = records.filter(r => {
    if (typeFilter && r.type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.value.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const handleExport = async () => {
    const token = localStorage.getItem('cg_token');
    const resp  = await fetch(`/api/v1/dns/zones/${zone.id}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url;
    a.download = `${zone.name}.zone`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Zone header */}
      <div className="px-5 py-4 border-b border-slate-200 bg-white">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-bold text-slate-900 text-lg font-mono">{zone.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${zone.type === 'reverse' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>
                {zone.type}
              </span>
              <span className="text-xs text-slate-500">{records.length} record{records.length !== 1 ? 's' : ''}</span>
              {!zone.is_active && <span className="text-xs text-amber-600 font-medium">Disabled</span>}
            </div>
            {zone.description && <p className="text-sm text-slate-500 mt-1">{zone.description}</p>}
          </div>
          <div className="flex gap-2">
            <button onClick={handleExport} className={BTN_GHOST + ' text-xs'}>
              Export .zone
            </button>
            <button onClick={() => setShowAdd(true)} className={BTN_PRIMARY + ' text-xs'}>
              + Add Record
            </button>
          </div>
        </div>

        <div className="flex gap-2 mt-3">
          <input className={INPUT + ' max-w-56'} placeholder="Search name or value…"
            value={search} onChange={e => setSearch(e.target.value)} />
          <select className={SELECT + ' w-28'} value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {RECORD_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {/* Records table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-8 text-center text-slate-400 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">
            {records.length === 0 ? 'No records yet — add one to get started.' : 'No records match your filter.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
              <tr>
                {['Name','Type','Value','TTL','Pri',''].map(h => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(r => (
                <tr key={r.id} className={`hover:bg-slate-50 ${!r.is_active ? 'opacity-40' : ''}`}>
                  <td className="px-4 py-2 font-mono text-sm text-slate-800 max-w-[180px] truncate">
                    {r.name}
                  </td>
                  <td className="px-4 py-2">
                    <TypeBadge type={r.type} />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600 max-w-[220px] truncate" title={r.value}>
                    {r.value}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400 tabular-nums">{r.ttl}</td>
                  <td className="px-4 py-2 text-xs text-slate-400 tabular-nums">{r.priority ?? '—'}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button onClick={() => setEditRecord(r)}
                      className="text-xs text-primary-600 hover:underline mr-3">Edit</button>
                    <button onClick={() => { if (confirm(`Delete ${r.type} record "${r.name}"?`)) deleteRec.mutate(r.id); }}
                      className="text-xs text-red-500 hover:underline">Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd    && <RecordModal zone={zone} onClose={() => setShowAdd(false)} />}
      {editRecord && <RecordModal record={editRecord} zone={zone} onClose={() => setEditRecord(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function DnsRecordsPage() {
  const qc = useQueryClient();
  const [selectedZone, setSelectedZone] = useState(null);
  const [showAddZone,  setShowAddZone]  = useState(false);
  const [editZone,     setEditZone]     = useState(null);

  const { data: zones = [], isLoading } = useQuery({
    queryKey: ['dns-zones'],
    queryFn:  () => api.get('/dns/zones'),
    onSuccess: rows => {
      if (!selectedZone && rows.length > 0) setSelectedZone(rows[0]);
    },
  });

  const deleteZone = useMutation({
    mutationFn: id => api.delete(`/dns/zones/${id}`),
    onSuccess:  () => {
      qc.invalidateQueries(['dns-zones']);
      setSelectedZone(null);
    },
  });

  const rebuildCache = useMutation({
    mutationFn: () => api.post('/dns/rebuild-local-cache'),
  });

  return (
    <div className="flex h-screen bg-slate-100">

      {/* ------------------------------------------------------------------ */}
      {/* Left: Zone list                                                     */}
      {/* ------------------------------------------------------------------ */}
      <div className="w-64 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col">
        <div className="px-4 py-4 border-b border-slate-200">
          <h1 className="font-bold text-slate-900">DNS Records</h1>
          <p className="text-xs text-slate-500 mt-0.5">Local authoritative zones</p>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {isLoading ? (
            <div className="px-4 py-8 text-center text-slate-400 text-sm">Loading…</div>
          ) : zones.length === 0 ? (
            <div className="px-4 py-6 text-center text-slate-400 text-sm">No zones yet</div>
          ) : (
            zones.map(z => (
              <button
                key={z.id}
                onClick={() => setSelectedZone(z)}
                className={`w-full text-left px-4 py-3 border-b border-slate-100 transition-colors ${
                  selectedZone?.id === z.id
                    ? 'bg-primary-50 border-l-2 border-l-primary-500'
                    : 'hover:bg-slate-50'
                }`}
              >
                <div className="font-mono text-sm font-medium text-slate-800 truncate">{z.name}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${z.type === 'reverse' ? 'bg-orange-100 text-orange-600' : 'bg-blue-100 text-blue-600'}`}>
                    {z.type}
                  </span>
                  <span className="text-xs text-slate-400">{z.record_count ?? 0} records</span>
                  {!z.is_active && <span className="text-xs text-amber-500">off</span>}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="px-3 py-3 border-t border-slate-200 space-y-1.5">
          <button onClick={() => setShowAddZone(true)}
            className={BTN_PRIMARY + ' w-full text-xs'}>
            + Add Zone
          </button>
          <button
            onClick={() => rebuildCache.mutate()}
            disabled={rebuildCache.isPending}
            className={BTN_GHOST + ' w-full text-xs border border-slate-200'}>
            {rebuildCache.isPending ? 'Rebuilding…' : 'Rebuild DNS Cache'}
          </button>
          {rebuildCache.data && (
            <p className="text-xs text-green-600 text-center">
              ✓ {rebuildCache.data.keys} entries cached
            </p>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Right: Records panel                                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {selectedZone ? (
          <>
            <RecordsPanel
              key={selectedZone.id}
              zone={zones.find(z => z.id === selectedZone.id) || selectedZone}
            />
            <div className="flex gap-2 px-5 py-2 border-t border-slate-200 bg-white">
              <button onClick={() => setEditZone(selectedZone)}
                className="text-xs text-slate-500 hover:text-slate-800 hover:underline">
                Edit zone settings
              </button>
              <span className="text-slate-300">·</span>
              <button
                onClick={() => {
                  if (confirm(`Delete zone "${selectedZone.name}" and all its records?`)) {
                    deleteZone.mutate(selectedZone.id);
                  }
                }}
                className="text-xs text-red-500 hover:underline">
                Delete zone
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-slate-400">
              <p className="text-lg font-medium">No zone selected</p>
              <p className="text-sm mt-1">Add a zone on the left to start managing DNS records.</p>
            </div>
          </div>
        )}
      </div>

      {showAddZone && <ZoneModal onClose={() => setShowAddZone(false)} />}
      {editZone    && <ZoneModal zone={editZone} onClose={() => { setEditZone(null); qc.invalidateQueries(['dns-zones']); }} />}
    </div>
  );
}
