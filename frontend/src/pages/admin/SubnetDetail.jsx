import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '../../lib/api';
import SubnetMap from '../../components/admin/SubnetMap';
import IpModal from '../../components/admin/IpModal';

const STATUS_BADGE = {
  static:      'badge-green',
  reservation: 'badge-blue',
  lease:       'bg-amber-100 text-amber-800 text-xs font-semibold px-2 py-0.5 rounded-full',
  conflict:    'bg-red-100 text-red-800 text-xs font-semibold px-2 py-0.5 rounded-full',
  free:        'badge-slate',
};

export default function SubnetDetail() {
  const { subnetId } = useParams();
  const [modalEntry, setModalEntry] = useState(null);
  const [search, setSearch]         = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['subnet-map', subnetId],
    queryFn:  () => api.get(`/ipam/subnets/${subnetId}/map`),
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="p-6 text-slate-400 text-sm">Loading subnet map…</div>;
  if (error)     return <div className="p-6 text-red-600 text-sm">Error: {error.message}</div>;

  const subnet = data?.subnet || {};

  // Normalize backend addresses to SubnetMap-compatible entry format
  function resolveStatus(addr) {
    if (addr.conflict) return 'conflict';
    const src = addr.source || '';
    if (src === 'dynamic') return 'lease';
    if (src === 'reservation') return 'reservation';
    if (src.startsWith('static')) return 'static';
    return 'free';
  }

  const rawAddresses = data?.addresses || [];
  const entries = rawAddresses.map(a => ({ ...a, status: resolveStatus(a) }));
  const utilization = data?.utilization || {};
  const stats = {
    total:       utilization.total       || 0,
    static:      utilization.static      || 0,
    reservation: utilization.reserved    || 0,
    lease:       utilization.dynamic     || 0,
    conflict:    utilization.conflicts   || 0,
  };
  const conflicts  = entries.filter(e => e.status === 'conflict');

  const filtered = entries.filter(e => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.ip?.includes(q) ||
      e.hostname?.toLowerCase().includes(q) ||
      e.mac_address?.toLowerCase().includes(q) ||
      e.owner?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-5 text-sm text-slate-400">
        <Link to="/admin/ipam" className="hover:text-primary-600">IPAM</Link>
        <span>›</span>
        <span className="text-slate-700">{subnet?.name || subnetId}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{subnet?.name || 'Subnet'}</h1>
          <div className="flex items-center gap-3 mt-1 text-sm text-slate-500">
            <span className="font-mono">{subnet?.cidr}</span>
            {subnet?.gateway && <span>GW: <span className="font-mono">{subnet.gateway}</span></span>}
            {subnet?.vlan_id  && <span>VLAN {subnet.vlan_id}</span>}
            {subnet?.location && <span>{subnet.location}</span>}
          </div>
        </div>
        <button className="btn-primary" onClick={() => setModalEntry({})}>
          + Document IP
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        {[
          { label: 'Total',        value: stats.total,       color: 'text-slate-700' },
          { label: 'Static',       value: stats.static,      color: 'text-green-700' },
          { label: 'Reservations', value: stats.reservation, color: 'text-blue-700' },
          { label: 'Active Leases',value: stats.lease,       color: 'text-amber-700' },
          { label: 'Conflicts',    value: stats.conflict,    color: conflicts.length ? 'text-red-700' : 'text-slate-400' },
        ].map(s => (
          <div key={s.label} className="card p-3 text-center">
            <div className={`text-xl font-bold ${s.color}`}>{s.value ?? 0}</div>
            <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Conflicts alert */}
      {conflicts.length > 0 && (
        <div className="mb-5 bg-red-50 border border-red-200 rounded-xl p-4 text-sm">
          <span className="font-semibold text-red-700">⚠ {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''} detected — </span>
          <span className="text-red-600">an IP is both statically assigned and has an active DHCP lease from an unexpected device.</span>
        </div>
      )}

      {/* Visual map */}
      <div className="card p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-700">Subnet Map</h2>
          <span className="text-xs text-slate-400">{entries.length} documented addresses</span>
        </div>
        <SubnetMap entries={filtered} onCellClick={e => e.status !== 'free' && setModalEntry(e)} />
      </div>

      {/* List table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-700 flex-1">Documented Addresses</h2>
          <input
            className="input w-52 text-sm"
            placeholder="Filter by IP, hostname, MAC…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">IP</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Hostname</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">MAC</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Owner</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.filter(e => e.status !== 'free').map(e => (
              <tr key={e.ip} className="hover:bg-slate-50">
                <td className="px-4 py-2.5 font-mono text-slate-800">{e.ip}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{e.hostname || '—'}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{e.mac_address || '—'}</td>
                <td className="px-4 py-2.5 text-xs text-slate-600 max-w-[160px] truncate">{e.owner || '—'}</td>
                <td className="px-4 py-2.5">
                  <span className={STATUS_BADGE[e.status] || 'badge-slate'}>{e.status}</span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {e.id && (
                    <button className="text-xs text-primary-600 hover:underline"
                      onClick={() => setModalEntry(e)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filtered.filter(e => e.status !== 'free').length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400 text-sm">
                  No documented addresses. Click <strong>+ Document IP</strong> to add one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* IP modal */}
      {modalEntry !== null && (
        <IpModal
          subnetId={subnetId}
          entry={modalEntry?.ip ? modalEntry : null}
          onClose={() => setModalEntry(null)}
        />
      )}
    </div>
  );
}
