import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../../lib/api';
import Avatar from '../../components/Avatar';

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      <div className="text-2xl font-bold text-slate-900">{value ?? '—'}</div>
      <div className="text-sm font-medium text-slate-600 mt-0.5">{label}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function UsageBar({ value, max }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full bg-primary-500 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-500 w-16 text-right">{formatDuration(value)}</span>
    </div>
  );
}

function toLocalInput(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export default function ScreenTimePage() {
  const [range, setRange] = useState({
    from: toLocalInput(Date.now() - 7 * 86400_000),
    to:   toLocalInput(Date.now()),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['screen-time-summary', range],
    queryFn:  () => api.get(`/screen-time/summary?from=${new Date(range.from).toISOString()}&to=${new Date(range.to).toISOString()}&limit=200`),
    refetchInterval: 60_000,
  });

  const students = data?.students ?? [];
  const max       = Math.max(1, ...students.map(s => s.active_seconds));
  const totalSecs = students.reduce((sum, s) => sum + s.active_seconds, 0);
  const avgSecs   = students.length ? Math.round(totalSecs / students.length) : 0;
  const heaviest  = students[0];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Screen Time</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Active device usage — Chromebooks and Macs only (same extension on both).
          Recording/reporting only, no limits are applied from this page.
        </p>
      </div>

      {/* Range picker */}
      <div className="card p-4 mb-5 flex items-end gap-3">
        <div>
          <label className="label">From</label>
          <input type="datetime-local" className="input text-xs" value={range.from}
            onChange={e => setRange(r => ({ ...r, from: e.target.value }))} />
        </div>
        <div>
          <label className="label">To</label>
          <input type="datetime-local" className="input text-xs" value={range.to}
            onChange={e => setRange(r => ({ ...r, to: e.target.value }))} />
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
        <StatCard label="Students with activity" value={students.length} sub="in this range" />
        <StatCard label="Average active time"     value={formatDuration(avgSecs)} sub="per student" />
        <StatCard label="Heaviest user"            value={heaviest ? formatDuration(heaviest.active_seconds) : '—'} sub={heaviest?.full_name} />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-800">Active time by student</h2>
        </div>

        {isLoading ? (
          <div className="p-10 text-center text-slate-400 text-sm">Loading…</div>
        ) : students.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-2xl mb-2">📵</div>
            <div className="text-sm text-slate-500">No screen-time data in this range yet.</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Student</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">OU</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide w-56">Active time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {students.map(s => (
                <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar name={s.full_name} email={s.email} />
                      <div>
                        <div className="font-medium text-slate-800 leading-none">{s.full_name || '—'}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{s.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 truncate max-w-[160px]">
                    {s.google_ou || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <UsageBar value={s.active_seconds} max={max} />
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
