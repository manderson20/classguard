import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function relativeTime(expiry) {
  if (!expiry) return '—';
  const ms = new Date(expiry * 1000) - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function pct(used, total) {
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

function UtilBar({ used, total }) {
  const p = pct(used, total);
  const color = p >= 90 ? 'bg-red-500' : p >= 70 ? 'bg-yellow-400' : 'bg-green-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${p}%` }} />
      </div>
      <span className="text-xs text-slate-500">
        {total != null ? `${used ?? 0}/${total}` : '—'}
      </span>
    </div>
  );
}

function Badge({ state }) {
  const colors = {
    hot_standby: 'bg-green-100 text-green-700',
    partner_down: 'bg-red-100 text-red-700',
    waiting: 'bg-yellow-100 text-yellow-700',
    load_balancing: 'bg-blue-100 text-blue-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[state] ?? 'bg-slate-100 text-slate-600'}`}>
      {state ?? 'unknown'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// HA Status widget
// ---------------------------------------------------------------------------
function HaStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ['dhcp-ha'],
    queryFn:  () => api.get('/dhcp/ha-status'),
    refetchInterval: 30_000,
  });

  if (isLoading) return null;
  if (!data?.ha) return null;

  return (
    <div className="mb-4 flex gap-3 flex-wrap">
      {data.nodes.map((node, i) => (
        <div key={i} className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm">
          <span className={`w-2 h-2 rounded-full ${node.result === 0 ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="font-medium text-slate-700">Node {i + 1}</span>
          <Badge state={node.state} />
          {node.result !== 0 && (
            <span className="text-xs text-red-500">{node.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subnets tab
// ---------------------------------------------------------------------------
const EMPTY_SUBNET = {
  kea_subnet_id: '', subnet: '', label: '', pool_start: '', pool_end: '',
  gateway: '', dns_servers: '127.0.0.1', domain_name: '', lease_time_seconds: 86400,
};

function SubnetsTab() {
  const qc = useQueryClient();
  const [modal, setModal]   = useState(null); // null | 'add' | { ...editRow }
  const [form, setForm]     = useState(EMPTY_SUBNET);
  const [delTarget, setDel] = useState(null);
  const [keaError, setErr]  = useState(null);

  const { data: subnets = [], isLoading } = useQuery({
    queryKey: ['dhcp-subnets'],
    queryFn:  () => api.get('/dhcp/subnets'),
    refetchInterval: 30_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['dhcp-subnets'] });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        kea_subnet_id: parseInt(form.kea_subnet_id, 10),
        lease_time_seconds: parseInt(form.lease_time_seconds, 10),
        dns_servers: form.dns_servers.split(',').map(s => s.trim()).filter(Boolean),
      };
      return modal === 'add'
        ? api.post('/dhcp/subnets', payload)
        : api.put(`/dhcp/subnets/${modal.id}`, payload);
    },
    onSuccess: () => { invalidate(); setModal(null); setErr(null); },
    onError:   err => setErr(err.message),
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/dhcp/subnets/${id}`),
    onSuccess:  () => { invalidate(); setDel(null); },
  });

  function openEdit(row) {
    setForm({
      kea_subnet_id: row.kea_subnet_id,
      subnet: row.subnet,
      label:  row.label ?? '',
      pool_start: row.pool_start,
      pool_end:   row.pool_end,
      gateway:    row.gateway ?? '',
      dns_servers: Array.isArray(row.dns_servers) ? row.dns_servers.join(', ') : (row.dns_servers ?? ''),
      domain_name: row.domain_name ?? '',
      lease_time_seconds: row.lease_time_seconds,
    });
    setModal(row);
  }

  if (isLoading) return <p className="text-slate-400 text-sm py-8 text-center">Loading…</p>;

  return (
    <>
      <div className="flex justify-end mb-3">
        <button className="btn-primary text-sm"
          onClick={() => { setForm(EMPTY_SUBNET); setModal('add'); }}>
          + Add Subnet
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
            <tr>
              {['Label','Subnet','Pool Range','Gateway','DNS','Lease Time','Utilization','IPAM',''].map(h => (
                <th key={h} className="px-3 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {subnets.map(s => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-medium text-slate-800">{s.label || '—'}</td>
                <td className="px-3 py-2 font-mono text-slate-700">{s.subnet}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">
                  {s.pool_start} – {s.pool_end}
                </td>
                <td className="px-3 py-2 text-slate-600">{s.gateway || '—'}</td>
                <td className="px-3 py-2 text-slate-600 text-xs">
                  {Array.isArray(s.dns_servers) ? s.dns_servers.join(', ') : s.dns_servers}
                </td>
                <td className="px-3 py-2 text-slate-600">{s.lease_time_seconds}s</td>
                <td className="px-3 py-2">
                  <UtilBar used={s.kea_stats?.used} total={s.kea_stats?.total} />
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {s.ipam_subnet_name
                    ? <a href="/admin/ipam" className="text-primary-600 hover:underline">{s.ipam_subnet_name}</a>
                    : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <button onClick={() => openEdit(s)}
                    className="text-xs text-primary-600 hover:underline mr-2">Edit</button>
                  <button onClick={() => setDel(s)}
                    className="text-xs text-red-500 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
            {!subnets.length && (
              <tr><td colSpan={9} className="text-center text-slate-400 py-8">No subnets configured</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add / Edit modal */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg">
            <h2 className="text-lg font-bold text-slate-900 mb-4">
              {modal === 'add' ? 'Add Subnet' : 'Edit Subnet'}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {[
                ['Kea Subnet ID', 'kea_subnet_id', 'number'],
                ['Subnet CIDR',   'subnet',        'text'],
                ['Label',         'label',         'text'],
                ['Pool Start',    'pool_start',    'text'],
                ['Pool End',      'pool_end',      'text'],
                ['Gateway',       'gateway',       'text'],
                ['DNS Servers',   'dns_servers',   'text'],
                ['Domain Name',   'domain_name',   'text'],
                ['Lease Time (s)','lease_time_seconds','number'],
              ].map(([label, key, type]) => (
                <label key={key} className="col-span-1 flex flex-col gap-1 text-xs font-medium text-slate-600">
                  {label}
                  <input type={type} value={form[key] ?? ''}
                    onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-primary-500" />
                </label>
              ))}
            </div>
            {keaError && <p className="text-red-500 text-xs mt-2">{keaError}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
              <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {delTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold text-slate-900 mb-2">Delete Subnet?</h2>
            <p className="text-slate-600 text-sm mb-1">
              This will remove <strong>{delTarget.subnet}</strong> from ClassGuard and Kea.
            </p>
            {delTarget.reservation_count > 0 && (
              <p className="text-amber-600 text-sm">
                ⚠️ {delTarget.reservation_count} reservation(s) will also be deleted.
              </p>
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setDel(null)} className="btn-secondary text-sm">Cancel</button>
              <button onClick={() => del.mutate(delTarget.id)} disabled={del.isPending}
                className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm hover:bg-red-700 disabled:opacity-50">
                {del.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reservations tab
// ---------------------------------------------------------------------------
const EMPTY_RES = { subnet_id: '', mac_address: '', ip_address: '', hostname: '' };

function ReservationsTab({ subnets }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [modal, setModal]   = useState(false);
  const [form, setForm]     = useState(EMPTY_RES);
  const [csvError, setCsvError] = useState(null);

  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ['dhcp-reservations'],
    queryFn:  async () => {
      const rows = await Promise.all(
        subnets.map(s => api.get(`/dhcp/subnets/${s.id}/reservations`)
          .then(r => r.map(res => ({ ...res, subnet_cidr: s.subnet, subnet_label: s.label })))
          .catch(() => []))
      );
      return rows.flat();
    },
    enabled: subnets.length > 0,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['dhcp-reservations'] });

  const add = useMutation({
    mutationFn: () => api.post('/dhcp/reservations', form),
    onSuccess:  () => { invalidate(); setModal(false); setForm(EMPTY_RES); },
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/dhcp/reservations/${id}`),
    onSuccess:  invalidate,
  });

  const filtered = search
    ? reservations.filter(r =>
        r.mac_address?.includes(search) ||
        r.ip_address?.includes(search)  ||
        r.hostname?.toLowerCase().includes(search.toLowerCase()) ||
        r.student_name?.toLowerCase().includes(search.toLowerCase()))
    : reservations;

  function importCsv(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      setCsvError(null);
      const lines = ev.target.result.split('\n').filter(Boolean);
      const errors = [];
      for (const line of lines) {
        const [mac, ip, hostname, subnet_id] = line.split(',').map(s => s.trim());
        if (!mac || !ip || !subnet_id) { errors.push(line); continue; }
        await api.post('/dhcp/reservations', { mac_address: mac, ip_address: ip, hostname, subnet_id })
          .catch(() => errors.push(line));
      }
      if (errors.length) setCsvError(`Failed rows: ${errors.slice(0, 3).join('; ')}`);
      invalidate();
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  if (isLoading) return <p className="text-slate-400 text-sm py-8 text-center">Loading…</p>;

  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search MAC, IP, hostname, student…"
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm flex-1 focus:outline-none focus:ring-1 focus:ring-primary-500" />
        <label className="btn-secondary text-sm cursor-pointer">
          Import CSV
          <input type="file" accept=".csv,.txt" className="hidden" onChange={importCsv} />
        </label>
        <button className="btn-primary text-sm" onClick={() => setModal(true)}>+ Add</button>
      </div>
      {csvError && <p className="text-amber-600 text-xs mb-2">{csvError}</p>}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
            <tr>
              {['MAC Address','IP Address','Hostname','Subnet','Student',''].map(h => (
                <th key={h} className="px-3 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map(r => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-slate-700">{r.mac_address}</td>
                <td className="px-3 py-2 font-mono text-slate-700">{r.ip_address}</td>
                <td className="px-3 py-2 text-slate-600">{r.hostname || '—'}</td>
                <td className="px-3 py-2 text-slate-600 text-xs">{r.subnet_label || r.subnet_cidr}</td>
                <td className="px-3 py-2 text-slate-600 text-xs">{r.student_name || '—'}</td>
                <td className="px-3 py-2">
                  <button onClick={() => del.mutate(r.id)}
                    className="text-xs text-red-500 hover:underline">Remove</button>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr><td colSpan={6} className="text-center text-slate-400 py-8">No reservations</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold text-slate-900 mb-4">Add Reservation</h2>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Subnet
                <select value={form.subnet_id} onChange={e => setForm(f => ({ ...f, subnet_id: e.target.value }))}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm">
                  <option value="">Select subnet…</option>
                  {subnets.map(s => (
                    <option key={s.id} value={s.id}>{s.label || s.subnet}</option>
                  ))}
                </select>
              </label>
              {[
                ['MAC Address (aa:bb:cc:dd:ee:ff)', 'mac_address'],
                ['IP Address', 'ip_address'],
                ['Hostname (optional)', 'hostname'],
              ].map(([label, key]) => (
                <label key={key} className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  {label}
                  <input value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500" />
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setModal(false)} className="btn-secondary text-sm">Cancel</button>
              <button onClick={() => add.mutate()} disabled={add.isPending} className="btn-primary text-sm">
                {add.isPending ? 'Adding…' : 'Add'}
              </button>
            </div>
            {add.isError && <p className="text-red-500 text-xs mt-2">{add.error?.message}</p>}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Active Leases tab
// ---------------------------------------------------------------------------
function LeasesTab() {
  const qc = useQueryClient();

  const { data: leases = [], isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['dhcp-leases'],
    queryFn:  () => api.get('/dhcp/leases'),
    refetchInterval: 30_000,
  });

  const expire = useMutation({
    mutationFn: ip => api.delete(`/dhcp/leases/${ip}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['dhcp-leases'] }),
  });

  function exportCsv() {
    const header = 'IP,MAC,Hostname,Expiry,Student\n';
    const rows = leases.map(l =>
      [l['ip-address'], l['hw-addr'], l.hostname ?? '',
       l['expire'] ? new Date(l['expire'] * 1000).toISOString() : '',
       l.student?.full_name ?? ''].join(',')
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'leases.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (isLoading) return <p className="text-slate-400 text-sm py-8 text-center">Loading…</p>;

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-slate-400">
          {leases.length} active lease{leases.length !== 1 ? 's' : ''} ·
          auto-refreshes every 30s
          {dataUpdatedAt ? ` · updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}
        </span>
        <button onClick={exportCsv} className="btn-secondary text-sm">Export CSV</button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
            <tr>
              {['IP Address','MAC Address','Hostname','Expires','Student',''].map(h => (
                <th key={h} className="px-3 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {leases.map(l => (
              <tr key={l['ip-address']} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-slate-800">{l['ip-address']}</td>
                <td className="px-3 py-2 font-mono text-slate-600 text-xs">{l['hw-addr']}</td>
                <td className="px-3 py-2 text-slate-600">{l.hostname || '—'}</td>
                <td className="px-3 py-2 text-slate-600">{relativeTime(l.expire)}</td>
                <td className="px-3 py-2 text-slate-600 text-xs">
                  {l.student ? (
                    <span>{l.student.full_name} <span className="text-slate-400">({l.student.email})</span></span>
                  ) : '—'}
                </td>
                <td className="px-3 py-2">
                  <button
                    onClick={() => {
                      if (window.confirm(`Force-expire lease for ${l['ip-address']}?`))
                        expire.mutate(l['ip-address']);
                    }}
                    className="text-xs text-red-500 hover:underline">
                    Force Expire
                  </button>
                </td>
              </tr>
            ))}
            {!leases.length && (
              <tr><td colSpan={6} className="text-center text-slate-400 py-8">No active leases</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Options tab
// ---------------------------------------------------------------------------
const COMMON_OPTIONS = [
  { label: 'DNS Servers',  option_name: 'domain-name-servers', option_code: 6,  placeholder: '8.8.8.8, 8.8.4.4' },
  { label: 'NTP Server',   option_name: 'ntp-servers',         option_code: 42, placeholder: '192.168.1.1' },
  { label: 'Domain Name',  option_name: 'domain-name',         option_code: 15, placeholder: 'school.local' },
  { label: 'TFTP Server',  option_name: 'tftp-server-name',    option_code: 66, placeholder: '192.168.1.10' },
  { label: 'Boot File',    option_name: 'bootfile-name',       option_code: 67, placeholder: 'pxelinux.0' },
];
const EMPTY_OPT = { option_name: '', option_label: '', option_data: '', option_code: '' };

function OptionsSection({ title, note, fetchFn, queryKey, createFn, updateFn, deleteFn }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null); // null | 'add' | { ...row }
  const [form, setForm]   = useState(EMPTY_OPT);
  const [quick, setQuick] = useState(null); // filled when quick-add chip clicked

  const { data: options = [] } = useQuery({ queryKey, queryFn: fetchFn });
  const inv = () => qc.invalidateQueries({ queryKey });

  const save = useMutation({
    mutationFn: () => {
      const payload = { ...form, option_code: form.option_code ? parseInt(form.option_code, 10) : null };
      return modal === 'add' ? createFn(payload) : updateFn(modal.id, payload);
    },
    onSuccess: () => { inv(); setModal(null); setQuick(null); },
  });

  const del = useMutation({
    mutationFn: id => deleteFn(id),
    onSuccess: inv,
  });

  const toggle = useMutation({
    mutationFn: opt => updateFn(opt.id, { ...opt, is_active: !opt.is_active }),
    onSuccess: inv,
  });

  function openQuick(preset) {
    setForm({ option_name: preset.option_name, option_label: preset.label, option_data: '', option_code: String(preset.option_code) });
    setQuick(preset);
    setModal('add');
  }

  function openEdit(opt) {
    setForm({ option_name: opt.option_name, option_label: opt.option_label || '', option_data: opt.option_data, option_code: opt.option_code ? String(opt.option_code) : '' });
    setModal(opt);
  }

  const INP = 'border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';

  return (
    <div>
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {note && <p className="text-xs text-slate-400 mt-0.5">{note}</p>}
        </div>
        <button className="btn-primary text-sm" onClick={() => { setForm(EMPTY_OPT); setQuick(null); setModal('add'); }}>
          + Add Option
        </button>
      </div>

      {/* Quick-add chips */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {COMMON_OPTIONS.map(p => (
          <button key={p.option_name} onClick={() => openQuick(p)}
            className="text-xs px-2.5 py-1 rounded-full border border-slate-300 text-slate-600 hover:border-primary-400 hover:text-primary-700 transition-colors">
            + {p.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>
              {['Code','Option Name','Label','Value','Active',''].map(h => (
                <th key={h} className="px-3 py-2 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {options.map(o => (
              <tr key={o.id} className={`hover:bg-slate-50 ${!o.is_active ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{o.option_code ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-700">{o.option_name}</td>
                <td className="px-3 py-2 text-slate-600">{o.option_label || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-800 max-w-xs truncate" title={o.option_data}>{o.option_data}</td>
                <td className="px-3 py-2">
                  <button onClick={() => toggle.mutate(o)}
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${o.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                    {o.is_active ? 'Active' : 'Disabled'}
                  </button>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-right space-x-2">
                  <button onClick={() => openEdit(o)} className="text-xs text-primary-600 hover:underline">Edit</button>
                  <button onClick={() => { if (confirm(`Delete option "${o.option_name}"?`)) del.mutate(o.id); }}
                    className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!options.length && (
              <tr><td colSpan={6} className="text-center text-slate-400 py-6 text-sm">
                No options configured — use quick-add chips or + Add Option above
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold text-slate-900 mb-4">
              {modal === 'add' ? (quick ? `Add: ${quick.label}` : 'Add Option') : `Edit: ${modal.option_name}`}
            </h2>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Option Name (Kea canonical)
                <input className={INP} value={form.option_name} placeholder="domain-name-servers"
                  onChange={e => setForm(f => ({ ...f, option_name: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Label (human-readable, optional)
                <input className={INP} value={form.option_label} placeholder="DNS Servers"
                  onChange={e => setForm(f => ({ ...f, option_label: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Value {quick && <span className="font-normal text-slate-400">e.g. {quick.placeholder}</span>}
                <input className={INP} value={form.option_data} placeholder={quick?.placeholder ?? ''}
                  onChange={e => setForm(f => ({ ...f, option_data: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Option Code (optional)
                <input className={INP} type="number" value={form.option_code}
                  onChange={e => setForm(f => ({ ...f, option_code: e.target.value }))} />
              </label>
            </div>
            {save.isError && <p className="text-red-500 text-xs mt-2">{save.error?.message}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => { setModal(null); setQuick(null); }} className="btn-secondary text-sm">Cancel</button>
              <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OptionsTab({ subnets }) {
  const [scopeId, setScopeId] = useState('');

  return (
    <div className="space-y-8">
      {/* Global options */}
      <OptionsSection
        title="Global Options"
        note="Applied to all DHCP scopes. Per-scope options below override these for the same option name."
        queryKey={['dhcp-options-global']}
        fetchFn={() => api.get('/dhcp/options')}
        createFn={payload => api.post('/dhcp/options', { ...payload, scope: 'global' })}
        updateFn={(id, payload) => api.put(`/dhcp/options/${id}`, payload)}
        deleteFn={id => api.delete(`/dhcp/options/${id}`)}
      />

      {/* Per-scope options */}
      <div className="border-t border-slate-200 pt-6">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-sm font-semibold text-slate-800 whitespace-nowrap">Per-Scope Options</h3>
          <select
            value={scopeId}
            onChange={e => setScopeId(e.target.value)}
            className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-primary-500 flex-1 max-w-xs">
            <option value="">Select a DHCP scope…</option>
            {subnets.map(s => (
              <option key={s.id} value={s.id}>{s.label ? `${s.label} (${s.subnet})` : s.subnet}</option>
            ))}
          </select>
        </div>

        {scopeId ? (
          <OptionsSection
            key={scopeId}
            title=""
            note="These override global options with the same name for this scope only."
            queryKey={['dhcp-options-subnet', scopeId]}
            fetchFn={() => api.get(`/dhcp/subnets/${scopeId}/options`)}
            createFn={payload => api.post(`/dhcp/subnets/${scopeId}/options`, { ...payload, scope: 'subnet' })}
            updateFn={(id, payload) => api.put(`/dhcp/subnets/${scopeId}/options/${id}`, payload)}
            deleteFn={id => api.delete(`/dhcp/subnets/${scopeId}/options/${id}`)}
          />
        ) : (
          <p className="text-sm text-slate-400 py-4 text-center">Select a scope above to manage its options</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = ['Subnets', 'Reservations', 'Active Leases', 'Options'];

export default function DhcpManagement() {
  const [tab, setTab] = useState('Subnets');
  const qc = useQueryClient();

  const { data: subnets = [] } = useQuery({
    queryKey: ['dhcp-subnets'],
    queryFn:  () => api.get('/dhcp/subnets'),
  });

  const syncKea = useMutation({
    mutationFn: () => api.post('/dhcp/sync-kea'),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['dhcp-subnets'] }),
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">DHCP Management</h1>
          <p className="text-slate-500 text-sm mt-0.5">ISC Kea integration — subnets, reservations, and active leases</p>
        </div>
        <button onClick={() => syncKea.mutate()} disabled={syncKea.isPending}
          className="btn-secondary text-sm">
          {syncKea.isPending ? 'Syncing…' : 'Sync to Kea'}
        </button>
      </div>

      <HaStatus />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 mb-4">
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

      {tab === 'Subnets'       && <SubnetsTab />}
      {tab === 'Reservations'  && <ReservationsTab subnets={subnets} />}
      {tab === 'Active Leases' && <LeasesTab />}
      {tab === 'Options'       && <OptionsTab subnets={subnets} />}
    </div>
  );
}
