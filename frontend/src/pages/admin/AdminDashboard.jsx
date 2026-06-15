import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../../lib/api';

function StatCard({ label, value, sub, color = 'blue' }) {
  const colors = {
    blue:   'bg-blue-50 text-blue-700 border-blue-100',
    green:  'bg-green-50 text-green-700 border-green-100',
    red:    'bg-red-50 text-red-700 border-red-100',
    slate:  'bg-slate-50 text-slate-700 border-slate-100',
  };
  return (
    <div className={`card p-5 border ${colors[color]}`}>
      <div className="text-2xl font-bold">{value ?? '—'}</div>
      <div className="text-sm font-semibold mt-0.5">{label}</div>
      {sub && <div className="text-xs opacity-70 mt-0.5">{sub}</div>}
    </div>
  );
}

function transformTrend(rows) {
  const map = {};
  rows.forEach(r => {
    const key = r.bucket;
    if (!map[key]) map[key] = { t: new Date(key).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), allowed: 0, blocked: 0 };
    map[key][r.action] = parseInt(r.count, 10);
  });
  return Object.values(map);
}

export default function AdminDashboard() {
  const { data: dns, isLoading: dnsLoading } = useQuery({
    queryKey:        ['dns-summary'],
    queryFn:         () => api.get('/dns/summary?hours=24'),
    refetchInterval: 60_000,
  });

  const { data: health } = useQuery({
    queryKey:        ['health'],
    queryFn:         () => fetch('/health').then(r => r.json()),
    refetchInterval: 30_000,
  });

  const trend = dns ? transformTrend(dns.hourly_trend || []) : [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="text-slate-500 text-sm mt-0.5">Last 24 hours · auto-refreshes every minute</p>
      </div>

      {/* System health */}
      <div className="flex items-center gap-3 mb-6 text-sm">
        <span className="font-semibold text-slate-600">System:</span>
        <span className={`flex items-center gap-1.5 ${health?.status === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
          <span className={`w-2 h-2 rounded-full ${health?.status === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
          {health?.status === 'ok' ? 'All systems operational' : 'Degraded'}
        </span>
        {health?.node && <span className="text-slate-400">Node: {health.node}</span>}
        {health?.version && <span className="text-slate-400">v{health.version}</span>}
      </div>

      {/* DNS stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Queries"   value={dnsLoading ? '…' : dns?.total?.toLocaleString()}   color="blue" />
        <StatCard label="Allowed"         value={dnsLoading ? '…' : dns?.allowed?.toLocaleString()}  color="green" />
        <StatCard label="Blocked"         value={dnsLoading ? '…' : dns?.blocked?.toLocaleString()}  color="red" />
        <StatCard label="Block Rate"      value={dnsLoading ? '…' : `${dns?.block_rate ?? 0}%`}      color="slate" sub="of all queries" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Query trend chart */}
        <div className="card p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">Query Trend (24h)</h2>
          {trend.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-slate-400 text-sm">No data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gAllowed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gBlocked" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} width={40} />
                <Tooltip />
                <Area type="monotone" dataKey="allowed" stroke="#22c55e" fill="url(#gAllowed)" strokeWidth={2} />
                <Area type="monotone" dataKey="blocked" stroke="#ef4444" fill="url(#gBlocked)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Top blocked domains */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-700">Top Blocked Domains</h2>
            <Link to="/admin/dns/logs?action=blocked" className="text-xs text-primary-600 hover:underline">View all</Link>
          </div>
          {(dns?.top_blocked_domains || []).length === 0 ? (
            <div className="text-slate-400 text-sm py-4 text-center">No blocked queries</div>
          ) : (
            <ul className="space-y-2">
              {(dns?.top_blocked_domains || []).map((d, i) => (
                <li key={d.domain} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-slate-400 w-4 text-right">{i + 1}</span>
                    <span className="truncate font-mono text-xs text-slate-700">{d.domain}</span>
                  </div>
                  <span className="badge-red text-xs ml-2 flex-shrink-0">{parseInt(d.count).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Top active students */}
      {(dns?.top_active_students || []).length > 0 && (
        <div className="card p-5 mt-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-700">Most Active Students (24h)</h2>
            <Link to="/admin/dns/logs" className="text-xs text-primary-600 hover:underline">View logs</Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {(dns.top_active_students || []).slice(0, 10).map(s => (
              <Link
                key={s.user_id}
                to={`/admin/users/${s.user_id}`}
                className="flex items-center gap-2 p-2 rounded-lg hover:bg-slate-50"
              >
                <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center text-xs font-bold text-primary-700 flex-shrink-0">
                  {(s.student_name || '?')[0].toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-800 truncate">{s.student_name || 'Unknown'}</div>
                  <div className="text-xs text-slate-400">{parseInt(s.count).toLocaleString()} queries</div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
        {[
          { to: '/admin/dns/stats',   icon: '📈', label: 'DNS Statistics' },
          { to: '/admin/users',       icon: '👥', label: 'Manage Users' },
          { to: '/admin/blocklists',  icon: '🛡️', label: 'Blocklists' },
          { to: '/admin/ipam',        icon: '🗺️', label: 'IP Management' },
        ].map(item => (
          <Link key={item.to} to={item.to} className="card p-4 flex items-center gap-3 hover:shadow-md transition-shadow">
            <span className="text-xl">{item.icon}</span>
            <span className="text-sm font-medium text-slate-700">{item.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
