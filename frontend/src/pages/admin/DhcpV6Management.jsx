import { useState, useEffect } from 'react';
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

// ---------------------------------------------------------------------------
// Router setup checklist — collapsible, remembers dismissed state
// ---------------------------------------------------------------------------
const STEPS = [
  {
    n: 1,
    title: 'Enable IPv6 on your router/LAN',
    detail: `In your router's IPv6 settings, choose "DHCPv6" or "Stateful DHCPv6" mode for the LAN (not SLAAC-only). The router handles routing and RA; ClassGuard handles address assignment and DNS.`,
  },
  {
    n: 2,
    title: 'Set the Managed flag (M-flag) in Router Advertisements',
    detail: 'This is the critical step. The M-flag tells IPv6 clients "use DHCPv6 to get your address" instead of self-assigning via SLAAC. Without it, devices will pick their own addresses and ignore ClassGuard\'s DHCPv6 server entirely. In UniFi: IPv6 → LAN → RA → Mode: Managed.',
  },
  {
    n: 3,
    title: 'Point the DHCPv6 DNS server to ClassGuard\'s IPv6 address',
    detail: 'In each subnet you create below, set DNS Servers to ClassGuard\'s own IPv6 address (the address this server is reachable on over IPv6). This is what routes clients\' DNS queries through ClassGuard\'s filter. Without this, clients will use a different DNS server and bypass filtering for IPv6 traffic.',
  },
  {
    n: 4,
    title: 'Verify with a client device',
    detail: 'After saving a subnet and syncing to Kea, connect a device and check its IPv6 configuration. It should show a DHCPv6-assigned address (not a privacy/SLAAC address) and ClassGuard\'s IPv6 address as its DNS server. The Active Leases tab will show the device\'s lease once it connects.',
  },
];

function RouterSetupNotice() {
  const storageKey = 'dhcpv6-setup-notice-dismissed';
  const [open, setOpen] = useState(() => localStorage.getItem(storageKey) !== '1');

  function dismiss() {
    localStorage.setItem(storageKey, '1');
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        onClick={() => { localStorage.removeItem(storageKey); setOpen(true); }}
        className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4 hover:bg-amber-100 transition-colors">
        <span className="font-medium">Router setup required</span>
        <span className="text-amber-500">— click to review checklist</span>
      </button>
    );
  }

  return (
    <div className="bg-amber-50 border border-amber-300 rounded-xl p-5 mb-5 shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="font-semibold text-amber-900 text-base">Router Setup Required</h3>
          <p className="text-xs text-amber-700 mt-0.5">
            ClassGuard handles address assignment and DNS — your router stays in charge of routing.
            Complete these steps before DHCPv6 will work on client devices.
          </p>
        </div>
        <button onClick={dismiss}
          className="text-xs text-amber-600 hover:text-amber-900 flex-shrink-0 underline underline-offset-2 mt-0.5">
          Dismiss
        </button>
      </div>

      <ol className="space-y-3">
        {STEPS.map(s => (
          <li key={s.n} className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-200 text-amber-900 text-xs font-bold flex items-center justify-center mt-0.5">
              {s.n}
            </span>
            <div>
              <p className="text-sm font-medium text-amber-900">{s.title}</p>
              <p className="text-xs text-amber-700 mt-0.5 leading-relaxed">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subnets tab
// ---------------------------------------------------------------------------
const EMPTY_SUBNET = {
  kea_subnet_id: '', subnet: '', label: '', pool_start: '', pool_end: '',
  dns_servers: '', domain_name: '', preferred_lifetime_seconds: 43200, valid_lifetime_seconds: 86400,
};

function SubnetsTab() {
  const qc = useQueryClient();
  const [modal, setModal]   = useState(null);
  const [form, setForm]     = useState(EMPTY_SUBNET);
  const [delTarget, setDel] = useState(null);
  const [keaError, setErr]  = useState(null);

  const { data: subnets = [], isLoading } = useQuery({
    queryKey: ['dhcpv6-subnets'],
    queryFn:  () => api.get('/dhcpv6/subnets'),
    refetchInterval: 30_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['dhcpv6-subnets'] });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        kea_subnet_id: parseInt(form.kea_subnet_id, 10),
        preferred_lifetime_seconds: parseInt(form.preferred_lifetime_seconds, 10),
        valid_lifetime_seconds:     parseInt(form.valid_lifetime_seconds, 10),
        dns_servers: form.dns_servers ? form.dns_servers.split(',').map(s => s.trim()).filter(Boolean) : null,
      };
      return modal === 'add'
        ? api.post('/dhcpv6/subnets', payload)
        : api.put(`/dhcpv6/subnets/${modal.id}`, payload);
    },
    onSuccess: () => { invalidate(); setModal(null); setErr(null); },
    onError:   err => setErr(err.message),
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/dhcpv6/subnets/${id}`),
    onSuccess:  () => { invalidate(); setDel(null); },
  });

  function openEdit(row) {
    setForm({
      kea_subnet_id: row.kea_subnet_id,
      subnet:        row.subnet,
      label:         row.label ?? '',
      pool_start:    row.pool_start,
      pool_end:      row.pool_end,
      dns_servers:   Array.isArray(row.dns_servers) ? row.dns_servers.join(', ') : (row.dns_servers ?? ''),
      domain_name:   row.domain_name ?? '',
      preferred_lifetime_seconds: row.preferred_lifetime_seconds,
      valid_lifetime_seconds:     row.valid_lifetime_seconds,
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
              {['Label','Subnet','Pool Range','DNS Servers','Preferred / Valid Lifetime','Utilization',''].map(h => (
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
                <td className="px-3 py-2 text-slate-600 text-xs">
                  {Array.isArray(s.dns_servers) ? s.dns_servers.join(', ') : (s.dns_servers || '—')}
                </td>
                <td className="px-3 py-2 text-slate-600 text-xs">
                  {s.preferred_lifetime_seconds}s / {s.valid_lifetime_seconds}s
                </td>
                <td className="px-3 py-2">
                  <UtilBar used={s.kea_stats?.used} total={s.kea_stats?.total} />
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
              <tr><td colSpan={7} className="text-center text-slate-400 py-8">No subnets configured</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg">
            <h2 className="text-lg font-bold text-slate-900 mb-4">
              {modal === 'add' ? 'Add IPv6 Subnet' : 'Edit IPv6 Subnet'}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {[
                ['Kea Subnet ID',        'kea_subnet_id',              'number'],
                ['Subnet CIDR',          'subnet',                     'text'],
                ['Label',                'label',                      'text'],
                ['Pool Start',           'pool_start',                 'text'],
                ['Pool End',             'pool_end',                   'text'],
                ['DNS Servers (IPv6)',   'dns_servers',                'text'],
                ['Domain Name',          'domain_name',                'text'],
                ['Preferred Lifetime (s)','preferred_lifetime_seconds','number'],
                ['Valid Lifetime (s)',   'valid_lifetime_seconds',     'number'],
              ].map(([label, key, type]) => (
                <label key={key} className="col-span-1 flex flex-col gap-1 text-xs font-medium text-slate-600">
                  {label}
                  <input type={type} value={form[key] ?? ''}
                    onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-primary-500" />
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-2">DNS Servers: comma-separated IPv6 addresses (e.g. 2001:db8::1)</p>
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

      {delTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold text-slate-900 mb-2">Delete Subnet?</h2>
            <p className="text-slate-600 text-sm mb-1">
              This will remove <strong>{delTarget.subnet}</strong> from ClassGuard and Kea.
            </p>
            {delTarget.reservation_count > 0 && (
              <p className="text-amber-600 text-sm">
                ⚠ {delTarget.reservation_count} reservation(s) will also be deleted.
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
// Reservations tab — DUID-based (not MAC)
// ---------------------------------------------------------------------------
const EMPTY_RES = { subnet_id: '', duid: '', ip_address: '', hostname: '' };

function ReservationsTab({ subnets }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [modal, setModal]   = useState(false);
  const [form, setForm]     = useState(EMPTY_RES);

  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ['dhcpv6-reservations'],
    queryFn:  async () => {
      const rows = await Promise.all(
        subnets.map(s => api.get(`/dhcpv6/subnets/${s.id}/reservations`)
          .then(r => r.map(res => ({ ...res, subnet_cidr: s.subnet, subnet_label: s.label })))
          .catch(() => []))
      );
      return rows.flat();
    },
    enabled: subnets.length > 0,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['dhcpv6-reservations'] });

  const add = useMutation({
    mutationFn: () => api.post('/dhcpv6/reservations', form),
    onSuccess:  () => { invalidate(); setModal(false); setForm(EMPTY_RES); },
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/dhcpv6/reservations/${id}`),
    onSuccess:  invalidate,
  });

  const filtered = search
    ? reservations.filter(r =>
        r.duid?.includes(search) ||
        r.ip_address?.includes(search) ||
        r.hostname?.toLowerCase().includes(search.toLowerCase()))
    : reservations;

  if (isLoading) return <p className="text-slate-400 text-sm py-8 text-center">Loading…</p>;

  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search DUID, IP, hostname…"
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm flex-1 focus:outline-none focus:ring-1 focus:ring-primary-500" />
        <button className="btn-primary text-sm" onClick={() => setModal(true)}>+ Add</button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-3">
        <p className="text-xs text-amber-800">
          <strong>DHCPv6 reservations use DUIDs, not MAC addresses.</strong> Find a device's DUID in the Active Leases tab once it has received an address, or from the device itself (<code>ip -6 addr</code> / system DHCPv6 client logs). Format example: <code className="font-mono">00:03:00:01:aa:bb:cc:dd:ee:ff</code>
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
            <tr>
              {['DUID','IP Address','Hostname','Subnet','Student',''].map(h => (
                <th key={h} className="px-3 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map(r => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.duid}</td>
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
            <h2 className="text-lg font-bold text-slate-900 mb-4">Add DHCPv6 Reservation</h2>
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
                ['DUID (e.g. 00:03:00:01:aa:bb:cc:dd:ee:ff)', 'duid'],
                ['IPv6 Address', 'ip_address'],
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
    queryKey: ['dhcpv6-leases'],
    queryFn:  () => api.get('/dhcpv6/leases'),
    refetchInterval: 30_000,
  });

  const expire = useMutation({
    mutationFn: ip => api.delete(`/dhcpv6/leases/${ip}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['dhcpv6-leases'] }),
  });

  if (isLoading) return <p className="text-slate-400 text-sm py-8 text-center">Loading…</p>;

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-slate-400">
          {leases.length} active lease{leases.length !== 1 ? 's' : ''} ·
          auto-refreshes every 30s
          {dataUpdatedAt ? ` · updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
            <tr>
              {['IPv6 Address','DUID','Type','Hostname','Expires',''].map(h => (
                <th key={h} className="px-3 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {leases.map(l => (
              <tr key={l['ip-address']} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-slate-800">{l['ip-address']}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{l.duid || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {l.type === 0 ? 'IA_NA' : l.type === 2 ? 'IA_PD' : l.type ?? '—'}
                </td>
                <td className="px-3 py-2 text-slate-600">{l.hostname || '—'}</td>
                <td className="px-3 py-2 text-slate-600">{relativeTime(l['valid-lft'] ? Date.now() / 1000 + l['valid-lft'] : null)}</td>
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
const COMMON_OPTIONS_V6 = [
  { label: 'DNS Servers',    option_name: 'dns-servers',    option_code: 23, placeholder: '2001:db8::1' },
  { label: 'Domain Search',  option_name: 'domain-search',  option_code: 24, placeholder: 'school.local' },
  { label: 'NTP Servers',    option_name: 'sntp-servers',   option_code: 31, placeholder: '2001:db8::1' },
];
const EMPTY_OPT = { option_name: '', option_label: '', option_data: '', option_code: '' };

function OptionsSection({ title, note, fetchFn, queryKey, createFn, updateFn, deleteFn }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY_OPT);
  const [quick, setQuick] = useState(null);

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

  const INP = 'border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';

  return (
    <div>
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {note && <p className="text-xs text-slate-400 mt-0.5">{note}</p>}
        </div>
        <button className="btn-primary text-sm"
          onClick={() => { setForm(EMPTY_OPT); setQuick(null); setModal('add'); }}>
          + Add Option
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {COMMON_OPTIONS_V6.map(p => (
          <button key={p.option_name}
            onClick={() => {
              setForm({ option_name: p.option_name, option_label: p.label, option_data: '', option_code: String(p.option_code) });
              setQuick(p);
              setModal('add');
            }}
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
                  <button onClick={() => {
                    setForm({ option_name: o.option_name, option_label: o.option_label || '', option_data: o.option_data, option_code: o.option_code ? String(o.option_code) : '' });
                    setModal(o);
                  }} className="text-xs text-primary-600 hover:underline">Edit</button>
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
                <input className={INP} value={form.option_name} placeholder="dns-servers"
                  onChange={e => setForm(f => ({ ...f, option_name: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Label (optional)
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
      <OptionsSection
        title="Global Options"
        note="Applied to all DHCPv6 scopes. Per-scope options below override these for the same option name."
        queryKey={['dhcpv6-options-global']}
        fetchFn={() => api.get('/dhcpv6/options')}
        createFn={payload => api.post('/dhcpv6/options', { ...payload, scope: 'global' })}
        updateFn={(id, payload) => api.put(`/dhcpv6/options/${id}`, payload)}
        deleteFn={id => api.delete(`/dhcpv6/options/${id}`)}
      />

      <div className="border-t border-slate-200 pt-6">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-sm font-semibold text-slate-800 whitespace-nowrap">Per-Scope Options</h3>
          <select
            value={scopeId}
            onChange={e => setScopeId(e.target.value)}
            className="border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-primary-500 flex-1 max-w-xs">
            <option value="">Select a scope…</option>
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
            queryKey={['dhcpv6-options-subnet', scopeId]}
            fetchFn={() => api.get(`/dhcpv6/subnets/${scopeId}/options`)}
            createFn={payload => api.post(`/dhcpv6/subnets/${scopeId}/options`, { ...payload, scope: 'subnet' })}
            updateFn={(id, payload) => api.put(`/dhcpv6/subnets/${scopeId}/options/${id}`, payload)}
            deleteFn={id => api.delete(`/dhcpv6/subnets/${scopeId}/options/${id}`)}
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

export default function DhcpV6Management() {
  const [tab, setTab] = useState('Subnets');
  const qc = useQueryClient();

  const { data: subnets = [] } = useQuery({
    queryKey: ['dhcpv6-subnets'],
    queryFn:  () => api.get('/dhcpv6/subnets'),
  });

  const syncKea = useMutation({
    mutationFn: () => api.post('/dhcpv6/sync-kea'),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['dhcpv6-subnets'] }),
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">DHCPv6 Management</h1>
          <p className="text-slate-500 text-sm mt-0.5">ISC Kea DHCPv6 — subnets, DUID reservations, and active leases</p>
        </div>
        <button onClick={() => syncKea.mutate()} disabled={syncKea.isPending}
          className="btn-secondary text-sm">
          {syncKea.isPending ? 'Syncing…' : 'Sync to Kea'}
        </button>
      </div>

      <RouterSetupNotice />

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

      {tab === 'Subnets'      && <SubnetsTab />}
      {tab === 'Reservations' && <ReservationsTab subnets={subnets} />}
      {tab === 'Active Leases'&& <LeasesTab />}
      {tab === 'Options'      && <OptionsTab subnets={subnets} />}
    </div>
  );
}
