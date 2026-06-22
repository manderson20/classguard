import { useState } from 'react';
import { Link } from 'react-router-dom';
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

function ActivityBar({ value, max }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full bg-primary-500 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-500 w-6 text-right">{value}</span>
    </div>
  );
}

function UtilizationBar({ pct }) {
  if (pct == null) return <span className="text-xs text-slate-300">No data</span>;
  const color = pct >= 60 ? 'bg-amber-500' : pct >= 25 ? 'bg-primary-500' : 'bg-slate-300';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-xs text-slate-500 w-10 text-right">{pct}%</span>
    </div>
  );
}

function RelativeTime({ ts }) {
  if (!ts) return <span className="text-slate-400">Never</span>;
  const diff   = Date.now() - new Date(ts).getTime();
  const mins   = Math.floor(diff / 60000);
  const hours  = Math.floor(diff / 3600000);
  const days   = Math.floor(diff / 86400000);
  const label  = days > 0 ? `${days}d ago` : hours > 0 ? `${hours}h ago` : `${mins}m ago`;
  const fresh  = days < 1;
  return (
    <span className={fresh ? 'text-green-600 font-medium' : 'text-slate-500'}>{label}</span>
  );
}

export default function StaffAnalyticsPage() {
  const [sort, setSort] = useState('last_login');

  const { data, isLoading } = useQuery({
    queryKey:        ['staff-analytics'],
    queryFn:         () => api.get('/analytics/staff'),
    refetchInterval: 60_000,
  });

  const { data: utilData } = useQuery({
    queryKey: ['staff-utilization'],
    queryFn:  () => api.get('/analytics/staff/utilization'),
    refetchInterval: 60_000,
  });

  const utilByTeacher = new Map((utilData?.teachers ?? []).map(t => [t.id, t]));

  const teachers   = (data?.teachers ?? []).map(t => {
    const u = utilByTeacher.get(t.id);
    const utilization_pct = u && Number(u.possible_student_seconds) > 0
      ? Math.round((Number(u.active_student_seconds) / Number(u.possible_student_seconds)) * 100)
      : null;
    return { ...t, utilization_pct };
  });
  const summary    = data?.summary    ?? {};
  const maxLessons = Math.max(1, ...teachers.map(t => t.lessons_30d ?? 0));
  const maxPenalty = Math.max(1, ...teachers.map(t => t.penalty_actions_30d ?? 0));

  const sorted = [...teachers].sort((a, b) => {
    if (sort === 'last_login')   return new Date(b.last_login_at ?? 0) - new Date(a.last_login_at ?? 0);
    if (sort === 'lessons')      return (b.lessons_30d ?? 0) - (a.lessons_30d ?? 0);
    if (sort === 'students')     return (b.student_count ?? 0) - (a.student_count ?? 0);
    if (sort === 'penalty')      return (b.penalty_actions_30d ?? 0) - (a.penalty_actions_30d ?? 0);
    if (sort === 'utilization')  return (b.utilization_pct ?? -1) - (a.utilization_pct ?? -1);
    return 0;
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Staff Analytics</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Teacher usage and classroom activity — last 30 days. "Device activity" measures how much of each
          teacher's scheduled periods their students actually spent active on a device, independent of
          whether a lesson was started — configure periods on the <Link to="/admin/bell-schedule" className="text-primary-600 hover:underline">Bell Schedule</Link> page.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total teachers"        value={summary.total_teachers}    sub="with teacher role" />
        <StatCard label="Active this week"       value={summary.active_this_week}  sub="logged in ≤ 7 days" />
        <StatCard label="Lessons started (30d)"  value={summary.total_lessons_30d} sub="across all classes" />
        <StatCard label="Avg class size"         value={summary.avg_class_size}    sub="enrolled students" />
      </div>

      {/* Teacher table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Teacher activity</h2>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>Sort by</span>
            {[
              { key: 'last_login', label: 'Last login'  },
              { key: 'lessons',    label: 'Lessons'     },
              { key: 'students',   label: 'Students'    },
              { key: 'penalty',    label: 'Penalty box' },
              { key: 'utilization', label: 'Device activity' },
            ].map(opt => (
              <button
                key={opt.key}
                onClick={() => setSort(opt.key)}
                className={`px-2 py-1 rounded-md transition-colors ${
                  sort === opt.key
                    ? 'bg-primary-100 text-primary-700 font-medium'
                    : 'hover:bg-slate-100 text-slate-500'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="p-10 text-center text-slate-400 text-sm">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-2xl mb-2">👩‍🏫</div>
            <div className="text-sm text-slate-500">No teachers found. Assign the teacher role to staff in the Users page.</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Teacher</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Last login</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Classes</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Students</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide w-40">Lessons (30d)</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide w-40">Penalty box (30d)</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide w-44">Device activity (scheduled periods)</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">OU</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {sorted.map(t => (
                <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar photoUrl={t.photo_url} name={t.full_name} email={t.email} />
                      <div>
                        <div className="font-medium text-slate-800 leading-none">{t.full_name || '—'}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{t.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <RelativeTime ts={t.last_login_at} />
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700 font-medium">{t.class_count ?? 0}</td>
                  <td className="px-4 py-3 text-sm text-slate-700 font-medium">{t.student_count ?? 0}</td>
                  <td className="px-4 py-3">
                    <ActivityBar value={t.lessons_30d ?? 0} max={maxLessons} />
                  </td>
                  <td className="px-4 py-3">
                    <ActivityBar value={t.penalty_actions_30d ?? 0} max={maxPenalty} />
                  </td>
                  <td className="px-4 py-3">
                    <UtilizationBar pct={t.utilization_pct} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 truncate max-w-[160px]">
                    {t.google_ou || <span className="text-slate-300">—</span>}
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
