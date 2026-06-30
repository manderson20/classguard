import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import {
  mdiMagnify,
  mdiDownload,
  mdiChevronLeft,
  mdiChevronRight,
} from '@mdi/js';
import api from '../../lib/api';

const OS_OPTIONS   = ['', 'ChromeOS', 'macOS', 'iOS', 'iPadOS'];

function useDebounced(value, delay = 300) {
  const [d, setD] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setD(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return d;
}

async function exportCsv() {
  const token = localStorage.getItem('cg_token');
  const res = await fetch('/api/v1/fleet/export.csv', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return;
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'Fleet Devices.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function SourceBadge({ source }) {
  const colors = {
    mosyle:       'bg-blue-100 text-blue-700',
    snipeit:      'bg-purple-100 text-purple-700',
    google_admin: 'bg-green-100 text-green-700',
  };
  const labels = {
    mosyle:       'Mosyle',
    snipeit:      'Snipe-IT',
    google_admin: 'Google',
  };
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${colors[source] || 'bg-slate-100 text-slate-500'}`}>
      {labels[source] || source}
    </span>
  );
}

function NetworkDot({ status }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${status === 'online' ? 'bg-green-400' : 'bg-slate-300'}`}
      title={status === 'online' ? 'Online' : 'Offline'}
    />
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

const LIMIT = 100;

export default function FleetDevices() {
  const [os,     setOs]     = useState('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useDebounced(search);

  // Reset offset when filters change
  useEffect(() => setOffset(0), [os, source, q]);

  const params = new URLSearchParams();
  if (os)     params.set('os', os);
  if (source) params.set('source', source);
  if (q)      params.set('q', q);
  params.set('limit',  String(LIMIT));
  params.set('offset', String(offset));

  const { data, isLoading } = useQuery({
    queryKey: ['fleet-devices', os, source, q, offset],
    queryFn:  () => api.get(`/fleet/devices?${params.toString()}`),
    staleTime: 30_000,
    keepPreviousData: true,
  });

  const devices = data?.devices || [];
  const total   = data?.total   || 0;
  const pages   = Math.ceil(total / LIMIT);
  const page    = Math.floor(offset / LIMIT) + 1;

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">All Devices</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {total > 0 ? `${total.toLocaleString()} devices` : 'All managed devices across integrations'}
          </p>
        </div>
        <button onClick={exportCsv} className="btn btn-secondary flex items-center gap-1.5 flex-shrink-0">
          <MdiIcon path={mdiDownload} size="1em" />
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={os}
          onChange={e => setOs(e.target.value)}
          className="input"
          style={{ width: 'auto' }}
        >
          <option value="">All OS</option>
          {OS_OPTIONS.filter(Boolean).map(o => <option key={o} value={o}>{o}</option>)}
        </select>

        <select
          value={source}
          onChange={e => setSource(e.target.value)}
          className="input"
          style={{ width: 'auto' }}
        >
          <option value="">All Sources</option>
          <option value="mosyle">Mosyle</option>
          <option value="snipeit">Snipe-IT</option>
          <option value="google_admin">Google Admin</option>
        </select>

        <div className="relative flex-1 min-w-[200px]">
          <MdiIcon
            path={mdiMagnify}
            size="1em"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search name, serial, email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="input w-full pl-9"
          />
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse h-8 bg-slate-100 rounded" />
            ))}
          </div>
        ) : devices.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">No devices match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-4 py-2 text-left">Device Name</th>
                  <th className="px-4 py-2 text-left">Serial</th>
                  <th className="px-4 py-2 text-left">Model</th>
                  <th className="px-4 py-2 text-left">OS</th>
                  <th className="px-4 py-2 text-left">Version</th>
                  <th className="px-4 py-2 text-left">Assigned</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-left">Sources</th>
                  <th className="px-4 py-2 text-left">Network</th>
                  <th className="px-4 py-2 text-left">Last Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {devices.map(d => (
                  <tr key={d.serialNumber} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2 font-medium text-slate-900">{d.deviceName || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.serialNumber}</td>
                    <td className="px-4 py-2 text-slate-600">{d.deviceModel || '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{d.osType || '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{d.osVersion || '—'}</td>
                    <td className="px-4 py-2 text-slate-600 text-xs">
                      <div>{d.assignedUser || '—'}</div>
                      {d.assignedEmail && <div className="text-slate-400">{d.assignedEmail}</div>}
                    </td>
                    <td className="px-4 py-2 text-slate-600">{d.status || '—'}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(d.sources || []).map(s => (
                          <SourceBadge key={s.source} source={s.source} />
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        <NetworkDot status={d.network?.status} />
                        <span className="text-xs text-slate-500">{d.network?.apName || ''}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {fmtDate(d.network?.lastSeen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > LIMIT && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {pages} — {total.toLocaleString()} total
          </span>
          <div className="flex gap-2">
            <button
              className="btn btn-secondary btn-sm flex items-center gap-1"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            >
              <MdiIcon path={mdiChevronLeft} size="1em" />
              Prev
            </button>
            <button
              className="btn btn-secondary btn-sm flex items-center gap-1"
              disabled={offset + LIMIT >= total}
              onClick={() => setOffset(offset + LIMIT)}
            >
              Next
              <MdiIcon path={mdiChevronRight} size="1em" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
