import { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function Badge({ label, color = 'slate' }) {
  const colors = {
    slate:  'bg-slate-100 text-slate-600',
    blue:   'bg-blue-100 text-blue-700',
    green:  'bg-green-100 text-green-700',
    red:    'bg-red-100 text-red-700',
    yellow: 'bg-yellow-100 text-yellow-700',
    purple: 'bg-purple-100 text-purple-700',
    orange: 'bg-orange-100 text-orange-700',
    amber:  'bg-amber-100 text-amber-700',
    cyan:   'bg-cyan-100 text-cyan-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[color] ?? colors.slate}`}>
      {label}
    </span>
  );
}

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

function Field({ label, children, hint }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      <span>{label}{hint && <span className="ml-1 font-normal text-slate-400">— {hint}</span>}</span>
      {children}
    </label>
  );
}

const INPUT  = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const SELECT = INPUT + ' bg-white';

function hostsInCidr(cidr, version = 4) {
  if (!cidr || version === 6) return null;
  try {
    const prefix = parseInt(cidr.split('/')[1], 10);
    if (prefix >= 31) return Math.pow(2, 32 - prefix);
    return Math.pow(2, 32 - prefix) - 2;
  } catch { return 0; }
}

function UtilBar({ used, total, compact = false, threshold = 90 }) {
  if (!total) return <span className="text-xs text-slate-400">{used || 0}</span>;
  const pct      = Math.min(100, Math.round((used / total) * 100));
  const overAlert = pct >= threshold;
  const barColor = overAlert ? 'bg-red-500' : pct >= threshold - 20 ? 'bg-amber-500' : 'bg-primary-500';
  if (compact) {
    return (
      <div className="flex items-center gap-2 min-w-[100px]" title={overAlert ? `Over ${threshold}% alert threshold` : undefined}>
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className={`h-full ${barColor} rounded-full`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-slate-500 tabular-nums">{used}/{total}</span>
        {overAlert && <span className="text-amber-500 text-xs" title={`Over ${threshold}% alert threshold`}>⚠</span>}
      </div>
    );
  }
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>{used} used / {total} hosts</span>
        <span className={overAlert ? 'text-red-600 font-semibold' : ''}>{pct}%{overAlert ? ` — over ${threshold}% threshold` : ''}</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const STATUS_COLOR = {
  used:     'bg-green-100 text-green-800',
  free:     'bg-slate-100 text-slate-600',
  reserved: 'bg-blue-100 text-blue-800',
  offline:  'bg-amber-100 text-amber-800',
  dhcp:     'bg-cyan-100 text-cyan-800',
};

// address_status — distinct from the presence/inventory `status` above:
// where the address's assignment comes from (admin-documented, a fixed
// DHCP reservation, or a currently-active dynamic lease).
const ADDRESS_STATUS_COLOR = {
  static:   'bg-slate-100 text-slate-600',
  reserved: 'bg-purple-100 text-purple-800',
  leased:   'bg-cyan-100 text-cyan-800',
};
const ADDRESS_STATUS_LABEL = { static: 'Static', reserved: 'Reserved', leased: 'Leased' };

function leaseRelativeTime(expiresAt) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt) - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

// ---------------------------------------------------------------------------
// Tag chip input
// ---------------------------------------------------------------------------
function TagInput({ value = [], onChange }) {
  const [draft, setDraft] = useState('');
  function commit() {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  }
  function remove(tag) { onChange(value.filter(t => t !== tag)); }
  return (
    <div className="border border-slate-300 rounded-md px-2 py-1.5 flex flex-wrap gap-1.5 focus-within:ring-1 focus-within:ring-primary-500 min-h-[36px]">
      {value.map(t => (
        <span key={t} className="inline-flex items-center gap-1 bg-primary-100 text-primary-800 text-xs px-2 py-0.5 rounded-full">
          {t}
          <button type="button" onClick={() => remove(t)} className="text-primary-500 hover:text-primary-900 leading-none">×</button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[100px] text-sm outline-none bg-transparent"
        placeholder="Type tag + Enter"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
        onBlur={commit}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CIDR Calculator tab
// ---------------------------------------------------------------------------
function cidrInfo(cidr) {
  try {
    const [ipStr, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;
    const parts = ipStr.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
    const ipInt   = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
    const mask    = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
    const netInt  = (ipInt & mask) >>> 0;
    const bcInt   = (netInt | (~mask >>> 0)) >>> 0;
    const first   = prefix < 31 ? netInt + 1 : netInt;
    const last    = prefix < 31 ? bcInt  - 1 : bcInt;
    const hosts   = prefix >= 31 ? Math.pow(2, 32 - prefix) : Math.pow(2, 32 - prefix) - 2;
    const int2ip  = n => [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join('.');
    const int2mask= n => int2ip(n);
    const wildcard= int2ip(~mask>>>0);
    return { network: int2ip(netInt), broadcast: int2ip(bcInt), first: int2ip(first),
             last: int2ip(last), mask: int2mask(mask), wildcard, hosts, prefix };
  } catch { return null; }
}

function CidrCalculator() {
  const [cidr, setCidr] = useState('');
  const info = cidr.includes('/') ? cidrInfo(cidr) : null;

  const splitOptions = info ? Array.from({ length: Math.min(10, 30 - info.prefix) }, (_, i) => {
    const p = info.prefix + i + 1;
    const count = Math.pow(2, p - info.prefix);
    const h = p >= 31 ? Math.pow(2, 32-p) : Math.pow(2, 32-p) - 2;
    return { prefix: p, count, hosts: h };
  }) : [];

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">Enter CIDR block</label>
        <input className={`${INPUT} font-mono text-base`} value={cidr} onChange={e => setCidr(e.target.value)}
          placeholder="10.10.0.0/24" />
      </div>

      {info && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {[
              ['Network Address', info.network],
              ['Broadcast Address', info.broadcast],
              ['First Usable Host', info.first],
              ['Last Usable Host', info.last],
              ['Subnet Mask', info.mask],
              ['Wildcard Mask', info.wildcard],
              ['Usable Hosts', info.hosts.toLocaleString()],
              ['Prefix Length', `/${info.prefix}`],
            ].map(([label, val]) => (
              <div key={label} className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <div className="text-xs text-slate-500 mb-0.5">{label}</div>
                <div className="font-mono font-semibold text-slate-800">{val}</div>
              </div>
            ))}
          </div>

          {splitOptions.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Split options</h3>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500 font-semibold uppercase">
                    <tr>{['Prefix','Subnets','Hosts/subnet','Total hosts'].map(h =>
                      <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {splitOptions.map(o => (
                      <tr key={o.prefix} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono font-semibold text-primary-700">/{o.prefix}</td>
                        <td className="px-3 py-2 text-slate-700">{o.count.toLocaleString()}</td>
                        <td className="px-3 py-2 text-slate-700">{o.hosts.toLocaleString()}</td>
                        <td className="px-3 py-2 text-slate-500">{(o.count * o.hosts).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      {cidr && !info && <p className="text-sm text-red-500">Enter a valid CIDR (e.g. 192.168.1.0/24)</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Locations tab
// ---------------------------------------------------------------------------
function LocationsTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ name: '', address: '', description: '' });
  const { data: locations = [] } = useQuery({ queryKey: ['ipam-locations'], queryFn: () => api.get('/ipam/locations') });
  const save = useMutation({
    mutationFn: () => modal === 'add'
      ? api.post('/ipam/locations', form)
      : api.put(`/ipam/locations/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ipam-locations'] }); setModal(null); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/locations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ipam-locations'] }),
  });
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));
  return (
    <>
      <div className="flex justify-end mb-3">
        <button className="btn-primary text-sm" onClick={() => { setForm({ name:'',address:'',description:'' }); setModal('add'); }}>+ Add Location</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Name','Address','Description',''].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {locations.map(l => (
              <tr key={l.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-semibold text-slate-800">{l.name}</td>
                <td className="px-3 py-2 text-slate-600 text-xs">{l.address || '—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{l.description || '—'}</td>
                <td className="px-3 py-2 text-right space-x-3">
                  <button onClick={() => { setForm(l); setModal(l); }} className="text-xs text-primary-600 hover:underline">Edit</button>
                  <button onClick={() => del.mutate(l.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!locations.length && <tr><td colSpan={4} className="text-center text-slate-400 py-8">No locations yet</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal === 'add' ? 'Add Location' : 'Edit Location'} onClose={() => setModal(null)}>
          <div className="flex flex-col gap-3">
            <Field label="Name"><input className={INPUT} value={form.name || ''} onChange={e => setF('name', e.target.value)} /></Field>
            <Field label="Address"><input className={INPUT} value={form.address || ''} onChange={e => setF('address', e.target.value)} placeholder="123 Main St"/></Field>
            <Field label="Description"><input className={INPUT} value={form.description || ''} onChange={e => setF('description', e.target.value)} /></Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">{save.isPending ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

const DEVICE_TYPES = ['server','workstation','laptop','printer','ap','switch','router','camera','voip','student','staff','tv','other'];
const EMPTY_IP = { ip: '', hostname: '', mac_address: '', owner: '', device_type: 'other', status: 'used', description: '', notes: '', is_gateway: false, tags: [], nat_public_ip: '' };

// ---------------------------------------------------------------------------
// IP form (shared between add + edit)
// ---------------------------------------------------------------------------
function IpForm({ form, setForm, isNew, subnetId, subnetIsPublic, error }) {
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const { data: publicIps = [] } = useQuery({
    queryKey: ['ipam-public-ips'],
    queryFn:  () => api.get('/ipam/public-ips'),
    enabled:  !isNew && !subnetIsPublic,
  });

  const getNextFree = useCallback(async () => {
    try {
      const r = await api.get(`/ipam/ipam-subnets/${subnetId}/next-free`);
      if (r.ip) f('ip', r.ip);
    } catch {}
  }, [subnetId]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Field label="IP Address">
            <input
              className={INPUT}
              value={form.ip}
              onChange={e => f('ip', e.target.value)}
              placeholder="192.168.1.100"
              disabled={!isNew}
            />
          </Field>
        </div>
        {isNew && (
          <button
            type="button"
            onClick={getNextFree}
            className="btn-secondary text-xs h-[34px] whitespace-nowrap flex-shrink-0"
          >
            Next Free
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Hostname">
          <input className={INPUT} value={form.hostname} onChange={e => f('hostname', e.target.value)} placeholder="server01.school.edu"/>
        </Field>
        <Field label="MAC Address">
          <input className={INPUT} value={form.mac_address} onChange={e => f('mac_address', e.target.value)} placeholder="AA:BB:CC:DD:EE:FF"/>
        </Field>
        <Field label="Owner">
          <input className={INPUT} value={form.owner} onChange={e => f('owner', e.target.value)} placeholder="IT Department"/>
        </Field>
        <Field label="Device Type">
          <select className={SELECT} value={form.device_type} onChange={e => f('device_type', e.target.value)}>
            {DEVICE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className={SELECT} value={form.status} onChange={e => f('status', e.target.value)}>
            <option value="used">Used — in service</option>
            <option value="reserved">Reserved — held for future use</option>
            <option value="offline">Offline — device down</option>
            <option value="free">Free — available</option>
          </select>
        </Field>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
            <input type="checkbox" checked={form.is_gateway} onChange={e => f('is_gateway', e.target.checked)} className="rounded"/>
            Mark as gateway
          </label>
        </div>
      </div>

      <Field label="Description">
        <input className={INPUT} value={form.description} onChange={e => f('description', e.target.value)} placeholder="Main file server"/>
      </Field>
      <Field label="Notes">
        <textarea className={INPUT + ' resize-none'} rows={2} value={form.notes} onChange={e => f('notes', e.target.value)}/>
      </Field>
      <Field label="Tags">
        <TagInput value={form.tags || []} onChange={v => f('tags', v)} />
      </Field>

      {!isNew && !subnetIsPublic && (
        <div className="border-t border-slate-200 pt-3 mt-1">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">NAT Mapping</div>
          {publicIps.length === 0 ? (
            <p className="text-xs text-slate-400">
              No public IPs available — mark a subnet as "Public IP space" in its settings first.
            </p>
          ) : (
            <Field label="Paired public IP" hint="auto-creates a static NAT rule in the NAT tab">
              <select
                className={SELECT}
                value={form.nat_public_ip || ''}
                onChange={e => f('nat_public_ip', e.target.value)}
              >
                <option value="">None</option>
                {publicIps.map(ip => (
                  <option key={ip.id} value={ip.ip}>
                    {ip.ip}{ip.hostname ? ` — ${ip.hostname}` : ''}{ip.subnet_name ? ` (${ip.subnet_name})` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {form.nat_public_ip && (
            <p className="text-xs text-slate-400 mt-1">
              A static NAT rule for <span className="font-mono">{form.ip} → {form.nat_public_ip}</span> will be saved automatically.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="text-red-500 text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error.message || 'Error saving IP'}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subnet IP view — drill-down into a subnet's addresses
// ---------------------------------------------------------------------------
function SubnetIpView({ subnet, onBack }) {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch]             = useState('');
  const [page, setPage]                 = useState(1);
  const [modal, setModal]               = useState(null); // null | 'add' | {ip record}
  const [form, setForm]                 = useState(EMPTY_IP);

  // Reset to page 1 whenever the filter or search changes
  useEffect(() => { setPage(1); }, [statusFilter, search]);

  const { data = { addresses: [], utilization: {}, pagination: {} }, isLoading } = useQuery({
    queryKey: ['ipam-addresses', subnet.id, statusFilter, search, page],
    queryFn: () => {
      const p = new URLSearchParams({ page, page_size: 50 });
      if (statusFilter) p.set('status', statusFilter);
      if (search)       p.set('search', search);
      return api.get(`/ipam/ipam-subnets/${subnet.id}/addresses?${p}`);
    },
    refetchInterval: 30_000,
    keepPreviousData: true,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['ipam-addresses', subnet.id] });
    qc.invalidateQueries({ queryKey: ['ipam-subnets'] });
  };

  const addIp = useMutation({
    mutationFn: () => api.post(`/ipam/ipam-subnets/${subnet.id}/addresses`, {
      ...form,
      mac_address: form.mac_address || null,
    }),
    onSuccess: () => { invalidate(); setModal(null); },
  });

  const editIp = useMutation({
    mutationFn: () => api.put(`/ipam/ipam-subnets/${subnet.id}/addresses/${modal.id}`, {
      hostname:      form.hostname    || null,
      mac_address:   form.mac_address || null,
      owner:         form.owner       || null,
      device_type:   form.device_type || null,
      status:        form.status,
      description:   form.description || null,
      notes:         form.notes       || null,
      is_gateway:    form.is_gateway,
      tags:          form.tags        || [],
      nat_public_ip: form.nat_public_ip || null,
    }),
    onSuccess: () => { invalidate(); setModal(null); },
  });

  const delIp = useMutation({
    mutationFn: id => api.delete(`/ipam/ipam-subnets/${subnet.id}/addresses/${id}`),
    onSuccess: invalidate,
  });

  const scanNow = useMutation({
    mutationFn: () => api.post(`/ipam/ipam-subnets/${subnet.id}/scan`),
    onSuccess: (r) => { invalidate(); alert(r.skipped || `Scanned ${r.scanned} address(es), ${r.alive} responded.`); },
    onError: (e) => alert('Scan failed: ' + (e.message || 'unknown')),
  });

  const reserveDhcp = useMutation({
    mutationFn: addr => api.post(`/ipam/ipam-subnets/${subnet.id}/addresses/${addr.id}/reserve-dhcp`, {}),
    onSuccess: invalidate,
    onError: (e) => alert('Reserve failed: ' + (e.message || 'unknown')),
  });

  const unreserveDhcp = useMutation({
    mutationFn: addr => api.delete(`/ipam/ipam-subnets/${subnet.id}/addresses/${addr.id}/reserve-dhcp`),
    onSuccess: invalidate,
    onError: (e) => alert('Remove reservation failed: ' + (e.message || 'unknown')),
  });

  const dhcpLinked = subnet.dhcp_enabled && subnet.dhcp_subnet_id;

  const util    = data.utilization || {};
  const pag     = data.pagination  || {};
  const total   = hostsInCidr(subnet.subnet, subnet.ip_version);
  const usedPct = util.total ? Math.min(100, Math.round(((util.used + (util.reserved||0) + (util.offline||0)) / util.total) * 100)) : 0;

  const openAdd  = (prefillIp) => { setForm({ ...EMPTY_IP, ip: prefillIp || '' }); setModal('add'); };
  const openEdit = row => { setForm({ ...row, mac_address: row.mac_address || '', hostname: row.hostname || '', owner: row.owner || '', description: row.description || '', notes: row.notes || '', nat_public_ip: row.nat_public_ip ? String(row.nat_public_ip).split('/')[0] : '' }); setModal(row); };

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <button onClick={onBack} className="text-primary-600 hover:underline font-medium">← Subnets</button>
        <span className="text-slate-400">›</span>
        <span className="font-mono text-slate-700">{subnet.subnet}</span>
        {subnet.name && <span className="text-slate-500">{subnet.name}</span>}
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            <span className="font-mono">{subnet.subnet}</span>
            {subnet.name && <span className="ml-2 font-normal text-lg text-slate-500">{subnet.name}</span>}
          </h2>
          <div className="flex flex-wrap gap-3 text-xs text-slate-500 mt-1">
            {subnet.section_name && <span>Section: <strong className="text-slate-700">{subnet.section_name}</strong></span>}
            {subnet.vrf_name     && <span>VRF: <strong className="text-slate-700">{subnet.vrf_name}</strong></span>}
            {subnet.vlan_name    && <span>VLAN <strong className="text-slate-700">{subnet.vlan_id} — {subnet.vlan_name}</strong></span>}
            {subnet.gateway      && <span>GW: <span className="font-mono text-slate-700">{subnet.gateway}</span></span>}
            {dhcpLinked && (
              <span className="bg-cyan-100 text-cyan-800 px-2 py-0.5 rounded-full font-medium">
                DHCP scope linked — pool {subnet.dhcp_pool_start} – {subnet.dhcp_pool_end}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => {
              const token = localStorage.getItem('cg_token');
              fetch(`/api/v1/ipam/export/addresses?subnet_id=${subnet.id}`, { headers: { Authorization: `Bearer ${token}` } })
                .then(r => r.blob()).then(blob => {
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = `addresses_${subnet.subnet.replace('/', '_')}.csv`;
                  a.click();
                });
            }}
            className="btn-secondary text-sm">
            Export CSV
          </button>
          <button onClick={() => scanNow.mutate()} disabled={scanNow.isPending} className="btn-secondary text-sm">
            {scanNow.isPending ? 'Scanning…' : 'Scan Now'}
          </button>
          <button onClick={openAdd} className="btn-primary text-sm">+ Add IP</button>
        </div>
      </div>

      {/* Utilization bar */}
      {total && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <UtilBar used={util.used || 0} total={util.total || total} threshold={subnet.alert_threshold_pct || 90} />
          <div className="flex gap-5 mt-3 text-xs">
            {[
              { label: 'Used',     value: util.used     ?? 0,        color: 'text-green-700'  },
              { label: 'Reserved', value: util.reserved ?? 0,        color: 'text-blue-700'   },
              { label: 'Offline',  value: util.offline  ?? 0,        color: 'text-amber-700'  },
              { label: 'Free',     value: util.free     ?? 0,        color: 'text-emerald-600' },
              { label: 'Total',    value: util.total    ?? total,    color: 'text-slate-700'  },
            ].map(s => (
              <div key={s.label} className="text-center">
                <div className={`font-bold text-base ${s.color}`}>{s.value}</div>
                <div className="text-slate-400">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status filters + search */}
      <div className="flex gap-2 flex-wrap items-center">
        {[
          ['', `All (${util.total ?? total ?? 0})`],
          ['used',     `Used (${util.used     ?? 0})`],
          ['reserved', `Reserved (${util.reserved ?? 0})`],
          ['offline',  `Offline (${util.offline  ?? 0})`],
          ['free',     `Free (${util.free     ?? 0})`],
        ].map(([v, l]) => (
          <button key={v} onClick={() => setStatusFilter(v)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors
              ${statusFilter === v
                ? 'bg-primary-600 text-white border-primary-600'
                : 'text-slate-600 border-slate-200 hover:bg-slate-100'}`}>
            {l}
          </button>
        ))}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search IP, hostname, MAC, owner, tag…"
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-xs w-56 ml-auto focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
      </div>

      {/* IP table */}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>
              {['IP Address','Hostname','MAC','Owner','Device','Tags','Status','Assignment','Last Seen',''].map(h =>
                <th key={h} className="px-3 py-2 text-left">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-slate-400">Loading…</td></tr>
            )}
            {!isLoading && data.addresses.map(addr => addr._synthetic ? (
              // Free / available IP — not yet documented
              <tr key={addr.ip} className="hover:bg-emerald-50/40">
                <td className="px-3 py-2">
                  <span className="font-mono text-slate-400">{addr.ip}</span>
                </td>
                <td className="px-3 py-2 text-slate-300 text-xs">—</td>
                <td className="px-3 py-2 text-slate-300 text-xs">—</td>
                <td className="px-3 py-2 text-slate-300 text-xs">—</td>
                <td className="px-3 py-2 text-slate-300 text-xs">—</td>
                <td className="px-3 py-2 text-slate-300 text-xs">—</td>
                <td className="px-3 py-2">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Available</span>
                </td>
                <td className="px-3 py-2 text-slate-300 text-xs">—</td>
                <td className="px-3 py-2 text-slate-300 text-xs">—</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button onClick={() => openAdd(addr.ip)} className="text-xs text-primary-600 hover:underline">+ Add</button>
                </td>
              </tr>
            ) : (
              // Documented IP
              <tr key={addr.id}
                className={`hover:bg-slate-50 ${addr.is_gateway ? 'bg-blue-50/30' : ''}`}>
                <td className="px-3 py-2">
                  <span className="font-mono text-slate-800">{addr.ip}</span>
                  {addr.is_gateway && <span className="ml-1 text-[10px] text-blue-600 font-semibold">GW</span>}
                </td>
                <td className="px-3 py-2 text-slate-700">{addr.hostname || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">
                  {addr.mac_address || '—'}
                  {addr.mac_vendor && <div className="text-[10px] text-slate-400 font-sans">{addr.mac_vendor}</div>}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600 max-w-[140px] truncate">{addr.owner || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500 capitalize">{addr.device_type || '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1 max-w-[140px]">
                    {(addr.tags || []).map(t => (
                      <span key={t} className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full">{t}</span>
                    ))}
                    {!addr.tags?.length && '—'}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_COLOR[addr.status] || 'bg-slate-100 text-slate-600'}`}>
                    {addr.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ADDRESS_STATUS_COLOR[addr.address_status] || 'bg-slate-100 text-slate-600'}`}>
                    {ADDRESS_STATUS_LABEL[addr.address_status] || addr.address_status}
                  </span>
                  {addr.address_status === 'leased' && (
                    <div className="text-[10px] text-slate-400 mt-0.5">{leaseRelativeTime(addr.lease_expires_at)}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${
                      addr.ping_status === 'online' ? 'bg-green-500' : addr.ping_status === 'offline' ? 'bg-slate-300' : 'bg-slate-200'
                    }`}
                    title={addr.ping_status ? `Last presence scan: ${addr.ping_status}` : 'Not yet scanned'}
                  />
                  {addr.last_seen ? new Date(addr.last_seen).toLocaleDateString() : '—'}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button onClick={() => openEdit(addr)} className="text-xs text-primary-600 hover:underline mr-2">Edit</button>
                  {dhcpLinked && addr.address_status === 'reserved' && (
                    <button
                      onClick={() => { if (confirm(`Remove the DHCP reservation for ${addr.ip}? It will become a regular DHCP-assignable address again.`)) unreserveDhcp.mutate(addr); }}
                      className="text-xs text-amber-600 hover:underline mr-2">
                      Un-reserve
                    </button>
                  )}
                  {dhcpLinked && addr.address_status !== 'reserved' && (
                    <button
                      onClick={() => {
                        if (!addr.mac_address) { alert('Add a MAC address to this IP before reserving it for DHCP.'); return; }
                        reserveDhcp.mutate(addr);
                      }}
                      className="text-xs text-purple-600 hover:underline mr-2">
                      Reserve
                    </button>
                  )}
                  <button onClick={() => { if (confirm(`Delete ${addr.ip}?`)) delIp.mutate(addr.id); }}
                    className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!isLoading && !data.addresses.length && (
              <tr><td colSpan={10} className="px-3 py-10 text-center text-sm text-slate-400">
                No IPs documented in this subnet — click <strong>+ Add IP</strong> to start
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pag.total_pages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-500 px-1">
          <span>
            Showing {((pag.page - 1) * pag.page_size + 1).toLocaleString()}–{Math.min(pag.page * pag.page_size, pag.total_rows).toLocaleString()} of {pag.total_rows.toLocaleString()}
            {pag.showing_free_ips && !statusFilter && ' (all IPs including available)'}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(p => p - 1)} disabled={page <= 1}
              className="btn btn-secondary btn-sm disabled:opacity-40">← Prev</button>
            <span className="px-3 py-1 text-slate-500">Page {pag.page} of {pag.total_pages}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={page >= pag.total_pages}
              className="btn btn-secondary btn-sm disabled:opacity-40">Next →</button>
          </div>
        </div>
      )}
      {pag.showing_free_ips === false && !search && (
        <p className="text-xs text-slate-400 text-center">
          This subnet is too large for automatic free-IP enumeration. Use the <strong>Free ({util.free ?? 0})</strong> count above as a reference.
        </p>
      )}

      {/* Add / Edit modal */}
      {modal !== null && (
        <Modal
          title={modal === 'add' ? 'Add IP Address' : `Edit ${modal.ip}`}
          onClose={() => setModal(null)}
          wide
        >
          <IpForm
            form={form}
            setForm={setForm}
            isNew={modal === 'add'}
            subnetId={subnet.id}
            subnetIsPublic={!!subnet.is_public}
            error={addIp.error || editIp.error}
          />
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button
              onClick={() => modal === 'add' ? addIp.mutate() : editIp.mutate()}
              disabled={addIp.isPending || editIp.isPending}
              className="btn-primary text-sm">
              {addIp.isPending || editIp.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV Import helpers + modal
// ---------------------------------------------------------------------------
const SUBNET_SAMPLE = `subnet,name,gateway,ip_version,description,notes
10.10.0.0/24,Student LAN,10.10.0.1,4,Student devices on VLAN 10,
192.168.1.0/24,Staff Network,192.168.1.1,4,Staff and admin devices,
10.20.0.0/22,Wireless Guest,10.20.0.1,4,,Guest isolation`;

const ADDRESS_SAMPLE = `subnet,ip,hostname,mac_address,owner,description,status,device_type
10.10.0.0/24,10.10.0.10,student-pc-01,aa:bb:cc:dd:ee:ff,John Smith,,used,desktop
10.10.0.0/24,10.10.0.20,lab-printer-01,,,HP LaserJet,reserved,printer
10.10.0.0/24,10.10.0.1,gw-core,,,Core router,reserved,router`;

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
}

function downloadSample(filename, content) {
  const blob = new Blob([content], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function ImportModal({ onClose, onDone }) {
  const [type, setType]     = useState('subnets');
  const [rows, setRows]     = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy]     = useState(false);

  const sample   = type === 'subnets' ? SUBNET_SAMPLE : ADDRESS_SAMPLE;
  const filename = type === 'subnets' ? 'classguard_subnets_sample.csv' : 'classguard_addresses_sample.csv';
  const hint = type === 'subnets'
    ? 'Required: subnet (CIDR). Optional: name, gateway, ip_version (default 4), description, notes, section (name), vlan_id (numeric).'
    : 'Required: subnet (CIDR matching an existing IPAM subnet), ip. Optional: hostname, mac_address, owner, description, status (used|free|reserved|offline|dhcp), device_type.';

  function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { setRows(parseCSV(ev.target.result)); setResult(null); };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function doImport() {
    if (!rows?.length) return;
    setBusy(true);
    try {
      const endpoint = type === 'subnets' ? '/ipam/import/subnets' : '/ipam/import/addresses';
      const res = await api.post(endpoint, rows);
      setResult(res);
      onDone();
    } catch (e) {
      setResult({ imported: 0, skipped: 0, errors: [e.message] });
    } finally {
      setBusy(false);
    }
  }

  const INP_FILE = 'flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-xl p-8 cursor-pointer hover:border-primary-400 transition-colors';

  return (
    <Modal title="Import CSV" onClose={onClose} wide>
      {/* Type selector */}
      <div className="flex gap-2 mb-4">
        {[['subnets', 'Subnets'], ['addresses', 'IP Addresses']].map(([v, l]) => (
          <button key={v} onClick={() => { setType(v); setRows(null); setResult(null); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors
              ${type === v ? 'bg-primary-600 text-white border-primary-600' : 'border-slate-300 text-slate-600 hover:border-primary-400'}`}>
            {l}
          </button>
        ))}
      </div>

      {/* Sample format */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">CSV Format</span>
          <button onClick={() => downloadSample(filename, sample)}
            className="text-xs text-primary-600 hover:underline font-medium">
            Download sample file
          </button>
        </div>
        <pre className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs font-mono text-slate-700 overflow-x-auto">
{sample}
        </pre>
        <p className="text-xs text-slate-400 mt-1.5">{hint}</p>
        {type === 'addresses' && (
          <p className="text-xs text-amber-600 mt-1">
            For phpIPAM exports: the subnet field must be CIDR notation (e.g. 10.10.0.0/24). Combine phpIPAM's subnet address + mask columns before importing.
          </p>
        )}
      </div>

      {/* File upload */}
      {!result && !rows && (
        <label className={INP_FILE}>
          <svg className="w-8 h-8 text-slate-300 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <span className="text-sm font-medium text-slate-600">Click to upload CSV</span>
          <span className="text-xs text-slate-400 mt-1">Header row required · comma-separated</span>
          <input type="file" accept=".csv,.txt" className="hidden" onChange={onFile} />
        </label>
      )}

      {/* Preview */}
      {rows && !result && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-medium text-slate-600">{rows.length} row{rows.length !== 1 ? 's' : ''} parsed — preview (first 5):</p>
            <label className="text-xs text-primary-600 hover:underline cursor-pointer">
              Change file
              <input type="file" accept=".csv,.txt" className="hidden" onChange={onFile} />
            </label>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="text-xs w-full">
              <thead className="bg-slate-50 text-slate-500">
                <tr>{rows[0] && Object.keys(rows[0]).map(h => (
                  <th key={h} className="px-2 py-1.5 text-left font-semibold">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.slice(0, 5).map((r, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    {Object.values(r).map((v, j) => (
                      <td key={j} className="px-2 py-1.5 text-slate-700 max-w-[140px] truncate font-mono">{v || <span className="text-slate-300">—</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className={`rounded-lg p-4 mb-4 ${result.errors?.length ? 'bg-amber-50 border border-amber-200' : 'bg-green-50 border border-green-200'}`}>
          <p className="text-sm font-semibold text-slate-800 mb-1">Import complete</p>
          <p className="text-sm text-slate-600">
            <span className="text-green-700 font-medium">{result.imported} imported</span>
            {result.skipped > 0 && <span className="text-slate-500"> · {result.skipped} skipped (already exist)</span>}
          </p>
          {result.errors?.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-semibold text-amber-700 mb-1">{result.errors.length} error(s):</p>
              <ul className="space-y-0.5">
                {result.errors.slice(0, 6).map((e, i) => (
                  <li key={i} className="text-xs text-amber-600 font-mono">{e}</li>
                ))}
                {result.errors.length > 6 && (
                  <li className="text-xs text-amber-400">…and {result.errors.length - 6} more</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 mt-2">
        <button onClick={onClose} className="btn-secondary text-sm">
          {result ? 'Close' : 'Cancel'}
        </button>
        {rows && !result && (
          <button onClick={doImport} disabled={busy} className="btn-primary text-sm">
            {busy ? `Importing ${rows.length} rows…` : `Import ${rows.length} row${rows.length !== 1 ? 's' : ''}`}
          </button>
        )}
        {result && (
          <button onClick={() => { setRows(null); setResult(null); }} className="btn-primary text-sm">
            Import another file
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tree building helpers
// ---------------------------------------------------------------------------
function buildTree(flat) {
  const byId = {};
  flat.forEach(s => { byId[s.id] = { ...s, _children: [] }; });
  const roots = [];
  flat.forEach(s => {
    if (s.parent_id && byId[s.parent_id]) byId[s.parent_id]._children.push(byId[s.id]);
    else roots.push(byId[s.id]);
  });
  const sort = arr => { arr.sort((a, b) => a.subnet < b.subnet ? -1 : 1); arr.forEach(n => sort(n._children)); };
  sort(roots);
  return roots;
}

function flattenTree(nodes, collapsed, ipvFilter, depth = 0) {
  const result = [];
  for (const node of nodes) {
    const visible = !ipvFilter || String(node.ip_version) === ipvFilter;
    if (visible) result.push({ ...node, _depth: depth });
    if (!collapsed.has(node.id) && node._children.length) {
      result.push(...flattenTree(node._children, collapsed, ipvFilter, visible ? depth + 1 : depth));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Split modal
// ---------------------------------------------------------------------------
function SplitModal({ subnet, onClose, onDone }) {
  const [prefix, setPrefix] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy]     = useState(false);
  const qc = useQueryClient();

  const parentPre = parseInt(subnet.subnet.split('/')[1], 10);
  const maxPre    = Math.min(30, parentPre + 10);
  const options   = Array.from({ length: maxPre - parentPre }, (_, i) => parentPre + i + 1);
  const numSubs   = prefix ? Math.pow(2, parseInt(prefix) - parentPre) : 0;
  const tooMany   = numSubs > 1024;

  async function doSplit() {
    setBusy(true);
    try {
      const res = await api.post(`/ipam/ipam-subnets/${subnet.id}/split`, { prefix: parseInt(prefix) });
      setResult(res);
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] });
      onDone();
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Split ${subnet.subnet}`} onClose={onClose}>
      {!result ? (
        <>
          <p className="text-sm text-slate-600 mb-4">
            Create equal-sized child subnets inside{' '}
            <span className="font-mono font-semibold">{subnet.subnet}</span>
            {subnet.name && <span className="text-slate-400"> ({subnet.name})</span>}.
          </p>
          <Field label="Split into prefix length">
            <select className={SELECT} value={prefix} onChange={e => setPrefix(e.target.value)}>
              <option value="">Select…</option>
              {options.map(p => (
                <option key={p} value={p}>
                  /{p} — {Math.pow(2, p - parentPre).toLocaleString()} subnets × {hostsInCidr(`0.0.0.0/${p}`, 4).toLocaleString()} hosts each
                </option>
              ))}
            </select>
          </Field>
          {prefix && (
            <div className={`mt-3 p-3 rounded-lg text-sm ${tooMany ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-blue-50 border border-blue-200 text-blue-700'}`}>
              {tooMany
                ? `${numSubs.toLocaleString()} subnets exceeds the 1,024 limit — choose a smaller split.`
                : `Will create ${numSubs.toLocaleString()} × /${prefix} subnets as children of ${subnet.subnet}. Already-existing subnets are skipped.`}
            </div>
          )}
          <div className="flex justify-end gap-2 mt-5">
            <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button onClick={doSplit} disabled={!prefix || tooMany || busy} className="btn-primary text-sm">
              {busy ? 'Splitting…' : `Split into /${prefix || '?'}`}
            </button>
          </div>
        </>
      ) : result.error ? (
        <>
          <p className="text-red-600 text-sm py-2">{result.error}</p>
          <div className="flex justify-end mt-4">
            <button onClick={onClose} className="btn-secondary text-sm">Close</button>
          </div>
        </>
      ) : (
        <>
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <p className="text-sm font-semibold text-slate-800">Split complete</p>
            <p className="text-sm text-slate-600 mt-1">
              <span className="text-green-700 font-medium">{result.created} subnet{result.created !== 1 ? 's' : ''} created</span>
              {result.skipped > 0 && <span className="text-slate-400"> · {result.skipped} already existed and were skipped</span>}
            </p>
          </div>
          <div className="flex justify-end mt-4">
            <button onClick={onClose} className="btn-primary text-sm">Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Subnets tab
// ---------------------------------------------------------------------------
const EMPTY_SUBNET = { subnet: '', ip_version: 4, name: '', description: '', gateway: '', notes: '', parent_id: null, is_public: false, dhcp_enabled: false, dhcp_pool_start: '', dhcp_pool_end: '', tags: [], location_id: null };

// ---------------------------------------------------------------------------
// Audit history modal (per subnet)
// ---------------------------------------------------------------------------
function AuditModal({ subnet, onClose }) {
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['ipam-audit', subnet.id],
    queryFn: () => api.get(`/ipam/audit?table_name=ipam_subnets&record_id=${subnet.id}&limit=30`),
  });
  const actionColor = { INSERT: 'bg-green-100 text-green-700', UPDATE: 'bg-blue-100 text-blue-700', DELETE: 'bg-red-100 text-red-700' };
  return (
    <Modal title={`Change History — ${subnet.subnet}${subnet.name ? ` (${subnet.name})` : ''}`} onClose={onClose} wide>
      {isLoading ? (
        <p className="text-sm text-slate-400 py-4 text-center">Loading…</p>
      ) : !logs.length ? (
        <p className="text-sm text-slate-400 py-4 text-center">No audit history yet for this subnet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 max-h-[60vh] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 font-semibold uppercase sticky top-0">
              <tr>{['When','Action','By','Summary'].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map(l => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                    {new Date(l.changed_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${actionColor[l.action] || 'bg-slate-100 text-slate-600'}`}>
                      {l.action}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{l.changed_by_name || '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{l.summary || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-end mt-4">
        <button onClick={onClose} className="btn-secondary text-sm">Close</button>
      </div>
    </Modal>
  );
}

function SubnetsTab({ sections, vrfs, vlans, onSelect }) {
  const qc = useQueryClient();
  const [modal, setModal]           = useState(null);
  const [form, setForm]             = useState(EMPTY_SUBNET);
  const [ipvFilter, setIpv]         = useState('');
  const [importOpen, setImport]     = useState(false);
  const [splitTarget, setSplit]     = useState(null);
  const [collapsed, setCollapsed]   = useState(new Set()); // nodes NOT in set are expanded
  const [syncResult, setSyncResult] = useState(null);
  const [auditTarget, setAuditTarget] = useState(null);

  const { data: subnets = [] } = useQuery({
    queryKey: ['ipam-subnets'],
    queryFn:  () => api.get('/ipam/ipam-subnets'),
  });

  const { data: locations = [] } = useQuery({
    queryKey: ['ipam-locations'],
    queryFn:  () => api.get('/ipam/locations'),
  });

  const save = useMutation({
    mutationFn: () => modal === 'add'
      ? api.post('/ipam/ipam-subnets', { ...form, ip_version: parseInt(form.ip_version, 10) })
      : api.put(`/ipam/ipam-subnets/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ipam-subnets'] }); setModal(null); },
  });

  const syncControllers = useMutation({
    mutationFn: () => api.post('/ipam/sync-from-controllers', {}),
    onSuccess:  data => setSyncResult(data),
    onError:    e    => setSyncResult({ error: e.message }),
  });

  function exportSubnets() {
    const token = localStorage.getItem('cg_token');
    fetch('/api/v1/ipam/export/subnets', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob()).then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'classguard_subnets.csv';
        a.click();
      });
  }

  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/ipam-subnets/${id}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['ipam-subnets'] }),
  });

  function toggleCollapse(id) {
    setCollapsed(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const ipvColor = v => v === 6 ? 'purple' : 'blue';
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const tree     = buildTree(subnets);
  const flatRows = flattenTree(tree, collapsed, ipvFilter);

  // Parent picker: subnets with shorter prefix than what's typed, excluding self
  const currentPrefix = (() => { const m = (form.subnet || '').match(/\/(\d+)$/); return m ? parseInt(m[1], 10) : null; })();
  const parentOptions = subnets.filter(s => {
    if (modal !== 'add' && s.id === modal?.id) return false;
    const p = parseInt((s.subnet || '').split('/')[1], 10);
    return !isNaN(p) && (currentPrefix === null || p < currentPrefix);
  });

  return (
    <>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <select value={ipvFilter} onChange={e => setIpv(e.target.value)} className={`${INPUT} w-36`}>
          <option value="">All versions</option>
          <option value="4">IPv4 only</option>
          <option value="6">IPv6 only</option>
        </select>
        <div className="flex gap-2 ml-auto flex-wrap">
          <button className="btn-secondary text-sm" onClick={exportSubnets}>Export CSV</button>
          <button className="btn-secondary text-sm" onClick={() => setImport(true)}>Import CSV</button>
          <button
            className="btn-secondary text-sm"
            onClick={() => syncControllers.mutate()}
            disabled={syncControllers.isPending}>
            {syncControllers.isPending ? 'Syncing…' : 'Sync from Controllers'}
          </button>
          <button className="btn-primary text-sm" onClick={() => { setForm(EMPTY_SUBNET); setModal('add'); }}>+ Add Subnet</button>
        </div>
      </div>

      {syncResult && (
        <div className={`mb-3 flex items-center justify-between px-4 py-2.5 rounded-lg text-sm border ${
          syncResult.error
            ? 'bg-red-50 border-red-200 text-red-700'
            : 'bg-green-50 border-green-200 text-green-700'}`}>
          <span>
            {syncResult.error
              ? `Sync error: ${syncResult.error}`
              : `Sync complete — ${syncResult.created} created, ${syncResult.updated} updated${syncResult.errors ? `, ${syncResult.errors} errors` : ''} (${syncResult.total} clients scanned)`}
          </span>
          <button onClick={() => setSyncResult(null)} className="ml-4 opacity-60 hover:opacity-100 text-lg leading-none">×</button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Subnet','Ver','Name','Section','VRF','VLAN','Gateway','Utilization',''].map(h =>
              <th key={h} className="px-3 py-2 text-left">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {flatRows.map(s => {
              const total      = hostsInCidr(s.subnet, s.ip_version);
              const hasKids    = s._children.length > 0;
              const isExpanded = !collapsed.has(s.id);
              const indent     = s._depth * 20;
              return (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="py-2 pr-3" style={{ paddingLeft: `${8 + indent}px` }}>
                    <div className="flex items-center gap-1">
                      {hasKids ? (
                        <button onClick={() => toggleCollapse(s.id)}
                          className="text-slate-400 hover:text-slate-700 w-4 text-xs flex-shrink-0 select-none leading-none">
                          {isExpanded ? '▼' : '▶'}
                        </button>
                      ) : (
                        <span className="w-4 flex-shrink-0" />
                      )}
                      <button onClick={() => onSelect(s)}
                        className="font-mono font-semibold text-primary-700 hover:underline text-left">
                        {s.subnet}
                      </button>
                      {s.is_public && (
                        <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-semibold ml-1">Public</span>
                      )}
                      {hasKids && (
                        <span className="text-xs text-slate-400 ml-1 font-normal">({s._children.length})</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2"><Badge label={`IPv${s.ip_version}`} color={ipvColor(s.ip_version)} /></td>
                  <td className="px-3 py-2 text-slate-700">{s.name || '—'}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{s.section_name || '—'}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{s.vrf_name || '—'}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{s.vlan_name ? `${s.vlan_id} ${s.vlan_name}` : '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{s.gateway || '—'}</td>
                  <td className="px-3 py-2 min-w-[120px]">
                    <UtilBar used={parseInt(s.ip_count) || 0} total={total} compact threshold={s.alert_threshold_pct || 90} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right space-x-3">
                    <button onClick={() => onSelect(s)} className="text-xs text-primary-600 hover:underline">IPs</button>
                    <button onClick={() => setSplit(s)} className="text-xs text-violet-600 hover:underline">Split</button>
                    <button onClick={() => { setForm({ ...s, parent_id: s.parent_id ?? null, tags: s.tags || [], location_id: s.location_id ?? null }); setModal(s); }}
                      className="text-xs text-slate-500 hover:underline">Edit</button>
                    <button onClick={() => setAuditTarget(s)} className="text-xs text-slate-400 hover:underline">History</button>
                    <button onClick={() => { if (confirm(`Delete ${s.subnet}?`)) del.mutate(s.id); }}
                      className="text-xs text-red-500 hover:underline">Del</button>
                  </td>
                </tr>
              );
            })}
            {!flatRows.length && (
              <tr><td colSpan={9} className="text-center text-slate-400 py-8 text-sm">
                No subnets yet — click <strong>+ Add Subnet</strong> to get started
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal title={modal === 'add' ? 'Add Subnet' : 'Edit Subnet'} onClose={() => setModal(null)} wide>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Subnet CIDR" hint="e.g. 10.10.0.0/24">
              <input className={INPUT} value={form.subnet} onChange={e => setF('subnet', e.target.value)} placeholder="10.10.0.0/24" disabled={modal !== 'add'}/>
            </Field>
            <Field label="IP Version">
              <select className={SELECT} value={form.ip_version} onChange={e => setF('ip_version', e.target.value)}>
                <option value={4}>IPv4</option>
                <option value={6}>IPv6</option>
              </select>
            </Field>
            <Field label="Name">
              <input className={INPUT} value={form.name || ''} onChange={e => setF('name', e.target.value)} placeholder="Student VLAN"/>
            </Field>
            <Field label="Gateway">
              <input className={INPUT} value={form.gateway || ''} onChange={e => setF('gateway', e.target.value)} placeholder="10.10.0.1"/>
            </Field>
            <Field label="Section">
              <select className={SELECT} value={form.section_id || ''} onChange={e => setF('section_id', e.target.value || null)}>
                <option value="">None</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="VRF">
              <select className={SELECT} value={form.vrf_id || ''} onChange={e => setF('vrf_id', e.target.value || null)}>
                <option value="">None</option>
                {vrfs.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
            <Field label="VLAN">
              <select className={SELECT} value={form.vlan_id || ''} onChange={e => setF('vlan_id', e.target.value || null)}>
                <option value="">None</option>
                {vlans.map(v => <option key={v.id} value={v.id}>{v.vlan_id} — {v.name}</option>)}
              </select>
            </Field>
            <div className="col-span-2">
              <Field label="Parent Subnet" hint="Supernet this subnet belongs to — e.g. 10.0.0.0/8 is parent of 10.10.0.0/16">
                <select className={SELECT} value={form.parent_id || ''} onChange={e => setF('parent_id', e.target.value || null)}>
                  <option value="">None (top-level)</option>
                  {parentOptions.map(s => (
                    <option key={s.id} value={s.id}>{s.subnet}{s.name ? ` — ${s.name}` : ''}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Location">
              <select className={SELECT} value={form.location_id || ''} onChange={e => setF('location_id', e.target.value || null)}>
                <option value="">None</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Description">
              <input className={INPUT} value={form.description || ''} onChange={e => setF('description', e.target.value)}/>
            </Field>
          </div>
          <Field label="Tags">
            <TagInput value={form.tags || []} onChange={v => setF('tags', v)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Alert threshold" hint="Warn when utilization reaches this %">
              <input type="number" min="1" max="100" className={INPUT}
                value={form.alert_threshold_pct ?? 90}
                onChange={e => setF('alert_threshold_pct', e.target.value ? parseInt(e.target.value, 10) : 90)} />
            </Field>
            <Field label="Presence scanning" hint="Periodic ping sweep for this subnet">
              <label className="flex items-center gap-2 mt-1.5 cursor-pointer select-none">
                <input type="checkbox" checked={form.scan_enabled !== false} onChange={e => setF('scan_enabled', e.target.checked)} />
                <span className="text-sm text-slate-600">Enabled</span>
              </label>
            </Field>
          </div>
          <Field label="Notes">
            <textarea className={INPUT + ' resize-none mt-3'} rows={2} value={form.notes || ''} onChange={e => setF('notes', e.target.value)}/>
          </Field>

          {/* Public IP space flag */}
          <div className="mt-4 pt-4 border-t border-slate-200">
            <label className="flex items-center gap-2 cursor-pointer select-none mb-3">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                checked={!!form.is_public} onChange={e => setF('is_public', e.target.checked)}/>
              <span className="text-sm font-semibold text-slate-700">Public IP space</span>
              <span className="text-xs text-slate-400">IPs in this subnet appear in the NAT pairing picker for private IPs</span>
            </label>
          </div>

          {/* DHCP Scope */}
          <div className="mt-4 pt-4 border-t border-slate-200">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                checked={!!form.dhcp_enabled} onChange={e => setF('dhcp_enabled', e.target.checked)}/>
              <span className="text-sm font-semibold text-slate-700">Enable DHCP Scope</span>
              {form.dhcp_subnet_id && (
                <span className="ml-2 text-xs bg-cyan-100 text-cyan-800 px-2 py-0.5 rounded-full font-medium">Linked to DHCP</span>
              )}
            </label>
            {form.dhcp_enabled && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <Field label="Pool Start IP" hint="First IP handed out by DHCP">
                  <input className={INPUT} value={form.dhcp_pool_start || ''} onChange={e => setF('dhcp_pool_start', e.target.value)} placeholder="10.10.0.100"/>
                </Field>
                <Field label="Pool End IP" hint="Last IP handed out by DHCP">
                  <input className={INPUT} value={form.dhcp_pool_end || ''} onChange={e => setF('dhcp_pool_end', e.target.value)} placeholder="10.10.0.200"/>
                </Field>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
          {save.isError && (
            <div className={`mt-2 px-3 py-2 rounded-lg text-xs border ${
              save.error?.overlap
                ? 'bg-amber-50 border-amber-200 text-amber-700'
                : 'bg-red-50 border-red-200 text-red-600'}`}>
              {save.error?.overlap
                ? `Overlap: this subnet conflicts with existing ${save.error.conflicting}. Adjust the CIDR or assign a different VRF.`
                : save.error?.message}
            </div>
          )}
        </Modal>
      )}

      {splitTarget && (
        <SplitModal subnet={splitTarget} onClose={() => setSplit(null)} onDone={() => setSplit(null)} />
      )}

      {importOpen && (
        <ImportModal
          onClose={() => setImport(false)}
          onDone={() => qc.invalidateQueries({ queryKey: ['ipam-subnets'] })}
        />
      )}

      {auditTarget && (
        <AuditModal subnet={auditTarget} onClose={() => setAuditTarget(null)} />
      )}

    </>
  );
}

// ---------------------------------------------------------------------------
// VLANs tab
// ---------------------------------------------------------------------------
function VlansTab({ sections }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ vlan_id: '', name: '', description: '' });

  const { data: vlans = [] } = useQuery({ queryKey: ['vlans'], queryFn: () => api.get('/ipam/vlans') });
  const save = useMutation({
    mutationFn: () => modal === 'add'
      ? api.post('/ipam/vlans', { ...form, vlan_id: parseInt(form.vlan_id, 10) })
      : api.put(`/ipam/vlans/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vlans'] }); setModal(null); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/vlans/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vlans'] }),
  });

  return (
    <>
      <div className="flex justify-end mb-3">
        <button className="btn-primary text-sm" onClick={() => { setForm({ vlan_id: '', name: '', description: '' }); setModal('add'); }}>
          + Add VLAN
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['VLAN ID', 'Name', 'Description', 'Section', ''].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {vlans.map(v => (
              <tr key={v.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-bold text-slate-800 font-mono">{v.vlan_id}</td>
                <td className="px-3 py-2 text-slate-700">{v.name || '—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{v.description || '—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{v.section_name || '—'}</td>
                <td className="px-3 py-2 text-right space-x-3">
                  <button onClick={() => { setForm(v); setModal(v); }} className="text-xs text-primary-600 hover:underline">Edit</button>
                  <button onClick={() => del.mutate(v.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!vlans.length && <tr><td colSpan={5} className="text-center text-slate-400 py-8">No VLANs yet</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal === 'add' ? 'Add VLAN' : 'Edit VLAN'} onClose={() => setModal(null)}>
          <div className="flex flex-col gap-3">
            {[['VLAN ID (1–4094)', 'vlan_id'], ['Name', 'name'], ['Description', 'description']].map(([l, k]) => (
              <Field key={k} label={l}>
                <input className={INPUT} value={form[k] || ''} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
              </Field>
            ))}
            <Field label="Section">
              <select className={SELECT} value={form.section_id || ''} onChange={e => setForm(f => ({ ...f, section_id: e.target.value || null }))}>
                <option value="">None</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// VRFs tab
// ---------------------------------------------------------------------------
function VrfsTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ name: '', rd: '', description: '' });

  const { data: vrfs = [] } = useQuery({ queryKey: ['vrfs'], queryFn: () => api.get('/ipam/vrfs') });
  const save = useMutation({
    mutationFn: () => modal === 'add' ? api.post('/ipam/vrfs', form) : api.put(`/ipam/vrfs/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vrfs'] }); setModal(null); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/vrfs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vrfs'] }),
  });

  return (
    <>
      <div className="flex justify-end mb-3">
        <button className="btn-primary text-sm" onClick={() => { setForm({ name: '', rd: '', description: '' }); setModal('add'); }}>
          + Add VRF
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Name', 'Route Distinguisher', 'Description', ''].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {vrfs.map(v => (
              <tr key={v.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-semibold text-slate-800">{v.name}</td>
                <td className="px-3 py-2 font-mono text-slate-600">{v.rd || '—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{v.description || '—'}</td>
                <td className="px-3 py-2 text-right space-x-3">
                  <button onClick={() => { setForm(v); setModal(v); }} className="text-xs text-primary-600 hover:underline">Edit</button>
                  <button onClick={() => del.mutate(v.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!vrfs.length && <tr><td colSpan={4} className="text-center text-slate-400 py-8">No VRFs yet</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal === 'add' ? 'Add VRF' : 'Edit VRF'} onClose={() => setModal(null)}>
          <div className="flex flex-col gap-3">
            {[['Name', 'name'], ['Route Distinguisher (e.g. 65000:100)', 'rd'], ['Description', 'description']].map(([l, k]) => (
              <Field key={k} label={l}>
                <input className={INPUT} value={form[k] || ''} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
              </Field>
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// BGP tab
// ---------------------------------------------------------------------------
const BGP_STATUS_COLOR = { active: 'green', inactive: 'slate', withdrawn: 'red' };
const EMPTY_BGP = { prefix: '', ip_version: 4, asn: '', peer_asn: '', peer_ip: '', next_hop: '', origin: 'IGP', status: 'active', description: '' };

function BgpTab({ vrfs }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY_BGP);
  const [filter, setFilter] = useState('');

  const { data: prefixes = [] } = useQuery({ queryKey: ['bgp-prefixes'], queryFn: () => api.get('/ipam/bgp') });
  const filtered = filter
    ? prefixes.filter(p => p.prefix.includes(filter) || String(p.asn).includes(filter))
    : prefixes;

  const save = useMutation({
    mutationFn: () => modal === 'add'
      ? api.post('/ipam/bgp', { ...form, asn: parseInt(form.asn) || null, peer_asn: parseInt(form.peer_asn) || null, ip_version: parseInt(form.ip_version, 10) })
      : api.put(`/ipam/bgp/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bgp-prefixes'] }); setModal(null); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/bgp/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bgp-prefixes'] }),
  });

  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by prefix or ASN…" className={`${INPUT} max-w-xs`} />
        <button className="btn-primary text-sm ml-auto" onClick={() => { setForm(EMPTY_BGP); setModal('add'); }}>+ Add Prefix</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Prefix', 'Ver', 'ASN', 'Peer ASN', 'Peer IP', 'Next Hop', 'Origin', 'Status', 'VRF', ''].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map(p => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono font-semibold text-slate-800">{p.prefix}</td>
                <td className="px-3 py-2"><Badge label={`IPv${p.ip_version}`} color={p.ip_version === 6 ? 'purple' : 'blue'} /></td>
                <td className="px-3 py-2 text-slate-600">{p.asn || '—'}</td>
                <td className="px-3 py-2 text-slate-600">{p.peer_asn || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{p.peer_ip || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{p.next_hop || '—'}</td>
                <td className="px-3 py-2"><Badge label={p.origin || '—'} color="slate" /></td>
                <td className="px-3 py-2"><Badge label={p.status} color={BGP_STATUS_COLOR[p.status] || 'slate'} /></td>
                <td className="px-3 py-2 text-xs text-slate-500">{p.vrf_name || '—'}</td>
                <td className="px-3 py-2 text-right space-x-3">
                  <button onClick={() => { setForm(p); setModal(p); }} className="text-xs text-primary-600 hover:underline">Edit</button>
                  <button onClick={() => del.mutate(p.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={10} className="text-center text-slate-400 py-8">No BGP prefixes</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal === 'add' ? 'Add BGP Prefix' : 'Edit BGP Prefix'} onClose={() => setModal(null)}>
          <div className="grid grid-cols-2 gap-3">
            {[['Prefix (CIDR)', 'prefix'], ['Origin ASN', 'asn'], ['Peer ASN', 'peer_asn'], ['Peer IP', 'peer_ip'], ['Next Hop', 'next_hop'], ['Description', 'description']].map(([l, k]) => (
              <Field key={k} label={l}>
                <input className={INPUT} value={form[k] || ''} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
              </Field>
            ))}
            <Field label="IP Version">
              <select className={SELECT} value={form.ip_version} onChange={e => setForm(f => ({ ...f, ip_version: e.target.value }))}>
                <option value={4}>IPv4</option><option value={6}>IPv6</option>
              </select>
            </Field>
            <Field label="Origin">
              <select className={SELECT} value={form.origin || 'IGP'} onChange={e => setForm(f => ({ ...f, origin: e.target.value }))}>
                {['IGP', 'EGP', 'INCOMPLETE'].map(o => <option key={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select className={SELECT} value={form.status || 'active'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {['active', 'inactive', 'withdrawn'].map(s => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="VRF">
              <select className={SELECT} value={form.vrf_id || ''} onChange={e => setForm(f => ({ ...f, vrf_id: e.target.value || null }))}>
                <option value="">None</option>
                {vrfs.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// NAT Rules tab
// ---------------------------------------------------------------------------
const NAT_TYPES = ['source', 'destination', 'masquerade', 'static', 'pat'];
const EMPTY_NAT = { name: '', nat_type: 'source', src_prefix: '', dst_prefix: '', translated_src: '', translated_dst: '', protocol: 'any', description: '' };

function NatTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY_NAT);

  const { data: rules = [] } = useQuery({ queryKey: ['nat-rules'], queryFn: () => api.get('/ipam/nat') });
  const save = useMutation({
    mutationFn: () => modal === 'add' ? api.post('/ipam/nat', form) : api.put(`/ipam/nat/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['nat-rules'] }); setModal(null); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/nat/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nat-rules'] }),
  });

  return (
    <>
      <div className="flex justify-end mb-3">
        <button className="btn-primary text-sm" onClick={() => { setForm(EMPTY_NAT); setModal('add'); }}>+ Add NAT Rule</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Name', 'Type', 'Source', 'Destination', 'Translated Src', 'Translated Dst', 'Proto', 'Active', 'IPAM', ''].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rules.map(r => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                <td className="px-3 py-2"><Badge label={r.nat_type} color="blue" /></td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.src_prefix || 'any'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.dst_prefix || 'any'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.translated_src || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.translated_dst || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.protocol}</td>
                <td className="px-3 py-2">
                  <span className={`w-2 h-2 rounded-full inline-block ${r.is_active ? 'bg-green-400' : 'bg-slate-300'}`} />
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {r.private_ip ? (
                    <span title={r.private_ip} className="font-mono">
                      {r.private_hostname || r.private_ip}
                    </span>
                  ) : '—'}
                </td>
                <td className="px-3 py-2 text-right space-x-3">
                  <button onClick={() => { setForm(r); setModal(r); }} className="text-xs text-primary-600 hover:underline">Edit</button>
                  <button onClick={() => del.mutate(r.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!rules.length && <tr><td colSpan={10} className="text-center text-slate-400 py-8">No NAT rules</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal === 'add' ? 'Add NAT Rule' : 'Edit NAT Rule'} onClose={() => setModal(null)} wide>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input className={INPUT} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="NAT Type">
              <select className={SELECT} value={form.nat_type} onChange={e => setForm(f => ({ ...f, nat_type: e.target.value }))}>
                {NAT_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </Field>
            {[['Source Prefix', 'src_prefix'], ['Destination Prefix', 'dst_prefix'],
              ['Translated Source', 'translated_src'], ['Translated Dest', 'translated_dst'],
              ['Src Port', 'src_port'], ['Dst Port', 'dst_port'],
              ['Translated Port', 'translated_port'], ['Interface', 'interface'],
              ['Description', 'description']].map(([l, k]) => (
              <Field key={k} label={l}>
                <input className={INPUT} value={form[k] || ''} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
              </Field>
            ))}
            <Field label="Protocol">
              <select className={SELECT} value={form.protocol || 'any'} onChange={e => setForm(f => ({ ...f, protocol: e.target.value }))}>
                {['any', 'tcp', 'udp', 'icmp'].map(p => <option key={p}>{p}</option>)}
              </select>
            </Field>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
                <input type="checkbox" checked={form.is_active !== false}
                  onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} className="rounded" />
                Active
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sections tab
// ---------------------------------------------------------------------------
function SectionsTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ name: '', description: '', color: '#3b82f6' });

  const { data: sections = [] } = useQuery({ queryKey: ['ipam-sections'], queryFn: () => api.get('/ipam/sections') });
  const save = useMutation({
    mutationFn: () => modal === 'add' ? api.post('/ipam/sections', form) : api.put(`/ipam/sections/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ipam-sections'] }); setModal(null); },
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/sections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ipam-sections'] }),
  });

  return (
    <>
      <div className="flex justify-end mb-3">
        <button className="btn-primary text-sm" onClick={() => { setForm({ name: '', description: '', color: '#3b82f6' }); setModal('add'); }}>
          + Add Section
        </button>
      </div>
      <div className="grid gap-3">
        {sections.map(s => (
          <div key={s.id} className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg bg-white shadow-sm">
            <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ background: s.color || '#3b82f6' }} />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-slate-800 text-sm">{s.name}</div>
              <div className="text-xs text-slate-500 truncate">{s.description || 'No description'}</div>
            </div>
            <button onClick={() => { setForm(s); setModal(s); }} className="text-xs text-primary-600 hover:underline">Edit</button>
            <button onClick={() => del.mutate(s.id)} className="text-xs text-red-500 hover:underline">Delete</button>
          </div>
        ))}
        {!sections.length && <p className="text-center text-slate-400 py-8 text-sm">No sections yet</p>}
      </div>
      {modal && (
        <Modal title={modal === 'add' ? 'Add Section' : 'Edit Section'} onClose={() => setModal(null)}>
          <div className="flex flex-col gap-3">
            {[['Name', 'name'], ['Description', 'description']].map(([l, k]) => (
              <Field key={k} label={l}>
                <input className={INPUT} value={form[k] || ''} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
              </Field>
            ))}
            <Field label="Color">
              <input type="color" value={form.color || '#3b82f6'}
                onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                className="h-8 w-16 rounded cursor-pointer border border-slate-300" />
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Search tab — global IP search across all IPAM subnets
// ---------------------------------------------------------------------------
function SearchTab({ onGoToSubnet }) {
  const [q, setQ] = useState('');
  const [query_, setQuery] = useState('');

  const { data: results = [], isFetching } = useQuery({
    queryKey: ['ipam-search', query_],
    queryFn:  () => query_.length >= 2 ? api.get(`/ipam/search?q=${encodeURIComponent(query_)}`) : Promise.resolve([]),
    enabled: query_.length >= 2,
  });

  const handleSearch = e => {
    e.preventDefault();
    setQuery(q);
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search by IP, hostname, MAC address, owner…"
          className={`${INPUT} max-w-lg`}
        />
        <button type="submit" className="btn-primary text-sm">Search</button>
      </form>

      {isFetching && <p className="text-sm text-slate-400">Searching…</p>}

      {!isFetching && query_.length >= 2 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>
                {['IP Address', 'Hostname', 'Owner', 'MAC', 'Device', 'Status', 'Subnet', ''].map(h =>
                  <th key={h} className="px-3 py-2 text-left">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {results.map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-slate-800">{r.ip}</td>
                  <td className="px-3 py-2 text-slate-700">{r.hostname || '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{r.owner || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">
                    {r.mac_address || '—'}
                    {r.mac_vendor && <div className="text-[10px] text-slate-400 font-sans">{r.mac_vendor}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 capitalize">{r.device_type || '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_COLOR[r.status] || 'bg-slate-100 text-slate-600'}`}>
                      {r.status || '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.subnet_name
                      ? <span><span className="font-mono">{r.subnet}</span> <span className="text-slate-400">{r.subnet_name}</span></span>
                      : <span className="font-mono text-slate-500">{r.subnet || '—'}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {r.subnet_id && (
                      <button onClick={() => onGoToSubnet(r.subnet_id)}
                        className="text-xs text-primary-600 hover:underline">
                        View subnet
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!results.length && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">
                  No results for "{query_}"
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {query_.length < 2 && !isFetching && (
        <p className="text-sm text-slate-400">Enter at least 2 characters and press Search.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multicast groups tab — e.g. VoIP paging zones spanning multiple closets
// ---------------------------------------------------------------------------
const MULTICAST_APPS = ['voip_paging', 'video', 'iot', 'other'];
const MULTICAST_APP_LABEL = { voip_paging: 'VoIP Paging', video: 'Video', iot: 'IoT', other: 'Other' };
const EMPTY_MULTICAST = { group_address: '', name: '', description: '', vlan_id: null, location_id: null, application: 'other', port: '', is_active: true, notes: '' };

function MulticastTab({ vlans }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY_MULTICAST);
  const [error, setError] = useState('');

  const { data: groups = [] }    = useQuery({ queryKey: ['multicast-groups'], queryFn: () => api.get('/ipam/multicast') });
  const { data: locations = [] } = useQuery({ queryKey: ['ipam-locations'],   queryFn: () => api.get('/ipam/locations') });

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, port: form.port ? parseInt(form.port, 10) : null };
      return modal === 'add' ? api.post('/ipam/multicast', body) : api.put(`/ipam/multicast/${modal.id}`, body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['multicast-groups'] }); setModal(null); setError(''); },
    onError: e => setError(e.message || 'Failed to save'),
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/multicast/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['multicast-groups'] }),
  });

  const openAdd  = () => { setForm(EMPTY_MULTICAST); setError(''); setModal('add'); };
  const openEdit = g => { setForm({ ...g, port: g.port || '' }); setError(''); setModal(g); };

  return (
    <>
      <div className="flex justify-end mb-3">
        <button className="btn-primary text-sm" onClick={openAdd}>+ Add Multicast Group</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Group Address', 'Name', 'Application', 'VLAN', 'Location', 'Port', 'Active', ''].map(h =>
              <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {groups.map(g => (
              <tr key={g.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-slate-800">{g.group_address}</td>
                <td className="px-3 py-2 text-slate-700">{g.name}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{MULTICAST_APP_LABEL[g.application] || g.application}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{g.vlan_tag ? `${g.vlan_tag} — ${g.vlan_name || ''}` : '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{g.location_name || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{g.port || '—'}</td>
                <td className="px-3 py-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${g.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                    {g.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-3 py-2 text-right space-x-3 whitespace-nowrap">
                  <button onClick={() => openEdit(g)} className="text-xs text-primary-600 hover:underline">Edit</button>
                  <button onClick={() => { if (confirm(`Delete multicast group ${g.name}?`)) del.mutate(g.id); }} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!groups.length && <tr><td colSpan={8} className="text-center text-slate-400 py-8">No multicast groups yet — used for things like VoIP paging zones.</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal === 'add' ? 'Add Multicast Group' : 'Edit Multicast Group'} onClose={() => setModal(null)}>
          <div className="flex flex-col gap-3">
            {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded p-2">{error}</div>}
            <Field label="Group Address" hint="Must be in 224.0.0.0/4 (IPv4 multicast)">
              <input className={INPUT} value={form.group_address} placeholder="239.1.1.10"
                onChange={e => setForm(f => ({ ...f, group_address: e.target.value }))} />
            </Field>
            <Field label="Name"><input className={INPUT} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Application">
              <select className={SELECT} value={form.application} onChange={e => setForm(f => ({ ...f, application: e.target.value }))}>
                {MULTICAST_APPS.map(a => <option key={a} value={a}>{MULTICAST_APP_LABEL[a]}</option>)}
              </select>
            </Field>
            <Field label="VLAN">
              <select className={SELECT} value={form.vlan_id || ''} onChange={e => setForm(f => ({ ...f, vlan_id: e.target.value || null }))}>
                <option value="">None</option>
                {vlans.map(v => <option key={v.id} value={v.id}>{v.vlan_id} — {v.name}</option>)}
              </select>
            </Field>
            <Field label="Location">
              <select className={SELECT} value={form.location_id || ''} onChange={e => setForm(f => ({ ...f, location_id: e.target.value || null }))}>
                <option value="">None</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Port" hint="Optional"><input className={INPUT} value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} /></Field>
            <Field label="Description"><input className={INPUT} value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></Field>
            <Field label="Active">
              <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Activity tab — global change log across all IPAM tables
// ---------------------------------------------------------------------------
const AUDIT_TABLES = {
  '': 'All', ipam_subnets: 'Subnets', ip_addresses: 'Addresses', vlans: 'VLANs', vrfs: 'VRFs',
  ipam_sections: 'Sections', bgp_prefixes: 'BGP', nat_rules: 'NAT', locations: 'Locations', multicast_groups: 'Multicast',
};

function ActivityTab() {
  const [tableFilter, setTableFilter] = useState('');
  const [limit, setLimit] = useState(50);
  const actionColor = { INSERT: 'bg-green-100 text-green-700', UPDATE: 'bg-blue-100 text-blue-700', DELETE: 'bg-red-100 text-red-700' };

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['ipam-audit-global', tableFilter, limit],
    queryFn: () => api.get(`/ipam/audit?limit=${limit}${tableFilter ? `&table_name=${tableFilter}` : ''}`),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select className={SELECT + ' w-48'} value={tableFilter} onChange={e => { setTableFilter(e.target.value); setLimit(50); }}>
          {Object.entries(AUDIT_TABLES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="text-xs text-slate-400">{logs.length} entries</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500 font-semibold uppercase">
            <tr>{['When', 'Table', 'Action', 'By', 'Summary'].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">Loading…</td></tr>}
            {!isLoading && logs.map(l => (
              <tr key={l.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{new Date(l.changed_at).toLocaleString()}</td>
                <td className="px-3 py-2 text-slate-500">{AUDIT_TABLES[l.table_name] || l.table_name}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${actionColor[l.action] || 'bg-slate-100 text-slate-600'}`}>{l.action}</span>
                </td>
                <td className="px-3 py-2 text-slate-600">{l.changed_by_name || '—'}</td>
                <td className="px-3 py-2 text-slate-600">{l.summary || '—'}</td>
              </tr>
            ))}
            {!isLoading && !logs.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">No activity recorded yet</td></tr>}
          </tbody>
        </table>
      </div>
      {logs.length >= limit && (
        <div className="text-center">
          <button onClick={() => setLimit(l => l + 50)} className="text-xs text-primary-600 hover:underline">Load more</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = ['Subnets', 'VLANs', 'VRFs', 'Sections', 'BGP', 'NAT', 'Locations', 'Multicast', 'Search', 'Calculator', 'Activity'];

export default function IpamFullPage() {
  const [tab, setTab]                   = useState('Subnets');
  const [activeSubnet, setActiveSubnet] = useState(null);

  const { data: sections = [] } = useQuery({ queryKey: ['ipam-sections'], queryFn: () => api.get('/ipam/sections') });
  const { data: vrfs = [] }     = useQuery({ queryKey: ['vrfs'],          queryFn: () => api.get('/ipam/vrfs') });
  const { data: vlans = [] }    = useQuery({ queryKey: ['vlans'],         queryFn: () => api.get('/ipam/vlans') });

  const goToSubnet = useCallback(async (subnetId) => {
    try {
      const s = await api.get(`/ipam/ipam-subnets/${subnetId}`);
      setActiveSubnet(s);
      setTab('Subnets');
    } catch {}
  }, []);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">IPAM</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          IP Address Management — IPv4, IPv6, VLANs, VRFs, BGP, NAT
          {' · '}
          <Link to="/admin/ipam/subnets" className="text-primary-600 hover:underline">Classic DHCP view →</Link>
        </p>
      </div>

      {!activeSubnet && (
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
      )}

      {activeSubnet ? (
        <SubnetIpView subnet={activeSubnet} onBack={() => setActiveSubnet(null)} />
      ) : (
        <>
          {tab === 'Subnets'    && <SubnetsTab sections={sections} vrfs={vrfs} vlans={vlans} onSelect={setActiveSubnet} />}
          {tab === 'VLANs'      && <VlansTab sections={sections} />}
          {tab === 'VRFs'       && <VrfsTab />}
          {tab === 'Sections'   && <SectionsTab />}
          {tab === 'BGP'        && <BgpTab vrfs={vrfs} />}
          {tab === 'NAT'        && <NatTab />}
          {tab === 'Locations'  && <LocationsTab />}
          {tab === 'Multicast'  && <MulticastTab vlans={vlans} />}
          {tab === 'Search'     && <SearchTab onGoToSubnet={goToSubnet} />}
          {tab === 'Calculator' && <CidrCalculator />}
          {tab === 'Activity'   && <ActivityTab />}
        </>
      )}
    </div>
  );
}
