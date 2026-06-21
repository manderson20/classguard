import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import api from '../../lib/api';

const ACTION_COLORS = {
  allowed: 'badge-green',
  blocked: 'badge-red',
};

function toLocalInput(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export default function BrowserHistoryPage() {
  const [searchParams] = useSearchParams();

  const [filters, setFilters] = useState({
    student_id: searchParams.get('student_id') || '',
    url:        '',
    action:     '',
    from:       toLocalInput(Date.now() - 86400_000),
    to:         toLocalInput(Date.now()),
  });
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ['browser-history', filters, page],
    queryFn: () => {
      const p = new URLSearchParams({
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
        from:  new Date(filters.from).toISOString(),
        to:    new Date(filters.to).toISOString(),
        page,
        limit: 50,
      });
      return api.get(`/extension/browser-history?${p}`);
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
        <h1 className="text-2xl font-bold text-slate-900">Browser History</h1>
        <p className="text-slate-500 text-sm mt-0.5">Persisted page navigations reported by the Chrome extension</p>
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
            <label className="label">URL contains</label>
            <input className="input" placeholder="facebook.com" value={filters.url}
              onChange={e => handleFilter('url', e.target.value)} />
          </div>
          <div>
            <label className="label">Action</label>
            <select className="input" value={filters.action} onChange={e => handleFilter('action', e.target.value)}>
              <option value="">All</option>
              <option value="allowed">Allowed</option>
              <option value="blocked">Blocked</option>
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
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Student</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Page</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {results.map(row => (
              <tr key={row.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">
                  {new Date(row.visited_at).toLocaleString()}
                </td>
                <td className="px-4 py-2.5 max-w-[160px]">
                  <div className="text-xs truncate">{row.student_name || row.user_id?.slice(0, 8) || '—'}</div>
                  {row.student_email && <div className="text-xs text-slate-400 truncate">{row.student_email}</div>}
                </td>
                <td className="px-4 py-2.5 max-w-md">
                  <a href={row.url} target="_blank" rel="noreferrer"
                    className="text-xs text-slate-700 hover:text-primary-600 hover:underline truncate block"
                    title={row.url}>
                    {row.title || row.url}
                  </a>
                  <div className="text-xs text-slate-400 font-mono truncate">{row.url}</div>
                  {row.block_reason && (
                    <div className="text-xs text-red-500 mt-0.5">{row.block_reason}</div>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {row.action ? (
                    <span className={ACTION_COLORS[row.action] || 'badge-slate'}>{row.action}</span>
                  ) : (
                    <span className="badge-slate">unknown</span>
                  )}
                </td>
              </tr>
            ))}
            {!isLoading && results.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-slate-400 text-sm">
                  No browsing history matches your filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
