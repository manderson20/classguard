import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../../lib/api';

function StatCard({ label, value, accent }) {
  return (
    <div className="card p-4">
      <div className={`text-2xl font-bold ${accent || 'text-slate-800'}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

const ACTION_LABELS = {
  started: { label: 'Session started', color: 'bg-purple-100 text-purple-700' },
  ended:   { label: 'Session ended',   color: 'bg-slate-100 text-slate-600' },
  request: { label: 'Change made',     color: 'bg-amber-100 text-amber-700' },
};

function ActionBadge({ action }) {
  const a = ACTION_LABELS[action] || { label: action, color: 'bg-slate-100 text-slate-600' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${a.color}`}>
      {a.label}
    </span>
  );
}

export default function ImpersonationAuditPage() {
  const [filters, setFilters] = useState({ admin_id: '', teacher_id: '', action: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['impersonation-audit', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.admin_id)   params.set('admin_id', filters.admin_id);
      if (filters.teacher_id) params.set('teacher_id', filters.teacher_id);
      if (filters.action)     params.set('action', filters.action);
      params.set('limit', '200');
      return api.get(`/impersonation/audit?${params}`);
    },
    refetchInterval: 30_000,
  });

  const entries = data?.entries || [];
  const total   = data?.total   || 0;
  const sessionCount = entries.filter(e => e.action === 'started').length;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Impersonation Audit</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Every "View as this teacher" session — who started it, every change made while it was active, and
          when it ended. This log is append-only — there is no way to edit or delete an entry from anywhere
          in ClassGuard, including direct database access (see the impersonation_audit migration for exactly
          what that guarantee does and doesn't cover).
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6 max-w-md">
        <StatCard label="Entries shown" value={total} />
        <StatCard label="Sessions started (shown)" value={sessionCount} accent="text-purple-700" />
      </div>

      <div className="flex gap-3 mb-4">
        <input
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm"
          placeholder="Filter by admin ID"
          value={filters.admin_id}
          onChange={e => setFilters(f => ({ ...f, admin_id: e.target.value }))}
        />
        <input
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm"
          placeholder="Filter by teacher ID"
          value={filters.teacher_id}
          onChange={e => setFilters(f => ({ ...f, teacher_id: e.target.value }))}
        />
        <select
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm"
          value={filters.action}
          onChange={e => setFilters(f => ({ ...f, action: e.target.value }))}
        >
          <option value="">All actions</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-6 text-slate-400 text-sm">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            <div className="font-medium">No entries match these filters</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Time</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Admin</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Viewing as</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Action</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {entries.map(e => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
                    {new Date(e.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-700">{e.admin_name || '—'}</div>
                    <div className="text-xs text-slate-400">{e.admin_email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-700">{e.teacher_name || '—'}</div>
                    <div className="text-xs text-slate-400">{e.teacher_email}</div>
                  </td>
                  <td className="px-4 py-3"><ActionBadge action={e.action} /></td>
                  <td className="px-4 py-3 text-xs text-slate-400 font-mono max-w-[280px] truncate" title={e.path || (e.detail ? JSON.stringify(e.detail) : '')}>
                    {e.method && e.path ? `${e.method} ${e.path}` : (e.detail ? JSON.stringify(e.detail) : '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
