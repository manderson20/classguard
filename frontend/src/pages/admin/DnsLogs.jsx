import { useState, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import api from '../../lib/api';

function ResolveRow({ domain }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dns-resolve', domain],
    queryFn:  () => api.get(`/dns/resolve?domain=${encodeURIComponent(domain)}`),
    staleTime: 30_000,
  });

  return (
    <tr className="bg-slate-50">
      <td colSpan={5} className="px-4 py-2.5 text-xs">
        {isLoading ? (
          <span className="text-slate-400">Looking up {domain} via 1.1.1.1 / 8.8.8.8…</span>
        ) : error ? (
          <span className="text-red-500">Lookup failed: {error.message}</span>
        ) : data.error && data.a.length === 0 && data.aaaa.length === 0 ? (
          <span className="text-amber-600">{domain}: {data.error}</span>
        ) : (
          <span className="text-slate-600">
            <strong className="font-mono">{domain}</strong> currently resolves to:{' '}
            {data.cname.length > 0 && <span className="font-mono text-slate-500">CNAME {data.cname.join(', ')} → </span>}
            {[...data.a, ...data.aaaa].map(ip => (
              <span key={ip} className="font-mono bg-white border border-slate-200 rounded px-1.5 py-0.5 mr-1">{ip}</span>
            ))}
            <span className="text-slate-400 ml-2">(live public lookup — not ClassGuard's own DNS)</span>
          </span>
        )}
      </td>
    </tr>
  );
}

const ACTION_COLORS = {
  allowed: 'badge-green',
  blocked: 'badge-red',
  unknown: 'badge-slate',
};

function toLocalInput(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export default function DnsLogs() {
  const [searchParams] = useSearchParams();

  const [filters, setFilters] = useState({
    student_id: '',
    domain:     '',
    action:     searchParams.get('action') || '',
    from:       toLocalInput(Date.now() - 86400_000),
    to:         toLocalInput(Date.now()),
  });
  const [page, setPage] = useState(1);
  const [lookupKey, setLookupKey] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['dns-logs', filters, page],
    queryFn: () => {
      const p = new URLSearchParams({
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
        from:  new Date(filters.from).toISOString(),
        to:    new Date(filters.to).toISOString(),
        page,
        limit: 50,
      });
      return api.get(`/dns/logs?${p}`);
    },
    keepPreviousData: true,
  });

  const { results = [], total = 0 } = data || {};
  const totalPages = Math.ceil(total / 50);

  function handleFilter(key, value) {
    setFilters(f => ({ ...f, [key]: value }));
    setPage(1);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">DNS Query Logs</h1>
        <p className="text-slate-500 text-sm mt-0.5">Powered by TimescaleDB — up to 4M+ queries/day</p>
      </div>

      {/* Filters */}
      <div className="card p-4 mb-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div>
            <label className="label">From</label>
            <input type="datetime-local" className="input text-xs" value={filters.from}
              onChange={e => handleFilter('from', e.target.value)} />
          </div>
          <div>
            <label className="label">To</label>
            <input type="datetime-local" className="input text-xs" value={filters.to}
              onChange={e => handleFilter('to', e.target.value)} />
          </div>
          <div>
            <label className="label">Domain</label>
            <input className="input" placeholder="facebook.com" value={filters.domain}
              onChange={e => handleFilter('domain', e.target.value)} />
          </div>
          <div>
            <label className="label">Action</label>
            <select className="input" value={filters.action} onChange={e => handleFilter('action', e.target.value)}>
              <option value="">All</option>
              <option value="allowed">Allowed</option>
              <option value="blocked">Blocked</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div>
            <label className="label">Student ID</label>
            <input className="input font-mono text-xs" placeholder="uuid…" value={filters.student_id}
              onChange={e => handleFilter('student_id', e.target.value)} />
          </div>
        </div>
      </div>

      {/* Results header */}
      <div className="flex items-center justify-between mb-3 text-sm text-slate-600">
        <span>
          {isLoading ? 'Loading…' : `${total.toLocaleString()} results`}
          {total > 0 && ` · page ${page} of ${totalPages}`}
        </span>
        <div className="flex gap-2">
          <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <button className="btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      </div>

      {error && <div className="card p-4 text-red-600 text-sm mb-4">Error: {error.message}</div>}

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Time</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">User / Device</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Domain</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Type</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {results.map((row, i) => {
              const key = row.id ?? i;
              return (
              <Fragment key={key}>
                <tr className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">
                    {new Date(row.queried_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 max-w-[160px]">
                    {row.user_id ? (
                      <>
                        <div className="text-xs truncate">{row.student_name || row.user_id.slice(0, 8)}</div>
                        {row.student_email && <div className="text-xs text-slate-400 truncate">{row.student_email}</div>}
                      </>
                    ) : (
                      <>
                        <div className="text-xs truncate">{row.device_name || row.source_ip || '—'}</div>
                        {row.device_name && row.source_ip && <div className="text-xs text-slate-400 font-mono truncate">{row.source_ip}</div>}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-700 max-w-xs truncate">
                    <button
                      onClick={() => setLookupKey(lookupKey === key ? null : key)}
                      className="hover:underline hover:text-primary-600"
                      title="Look up what this domain resolves to right now"
                    >
                      {row.domain}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-400">{row.query_type || 'A'}</td>
                  <td className="px-4 py-2.5">
                    <span className={ACTION_COLORS[row.action] || 'badge-slate'}>{row.action}</span>
                  </td>
                </tr>
                {lookupKey === key && <ResolveRow domain={row.domain} />}
              </Fragment>
              );
            })}
            {!isLoading && results.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-slate-400 text-sm">
                  No log entries match your filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
