import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import api from '../../lib/api';

const PRESETS = [
  { label: '1h',  hours: 1,   bucket: '1hour' },
  { label: '24h', hours: 24,  bucket: '1hour' },
  { label: '7d',  hours: 168, bucket: '1day'  },
  { label: '30d', hours: 720, bucket: '1day'  },
];

function transformTrend(rows) {
  const map = {};
  rows.forEach(r => {
    const key = r.bucket;
    if (!map[key]) map[key] = { label: '', allowed: 0, blocked: 0, unknown: 0 };
    map[key].label = new Date(key).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    map[key][r.action] = parseInt(r.total_queries, 10);
  });
  return Object.values(map);
}

export default function DnsStats() {
  const [preset, setPreset] = useState(PRESETS[1]);

  const from = new Date(Date.now() - preset.hours * 3600_000).toISOString();
  const to   = new Date().toISOString();

  const { data: summary, isLoading: sLoading } = useQuery({
    queryKey: ['dns-summary', preset.hours],
    queryFn:  () => api.get(`/dns/summary?hours=${preset.hours}`),
    refetchInterval: 60_000,
  });

  const { data: trend = [], isLoading: tLoading } = useQuery({
    queryKey: ['dns-stats', preset.bucket, from, to],
    queryFn:  () => api.get(`/dns/stats?bucket=${preset.bucket}&from=${from}&to=${to}`),
  });

  const chartData  = transformTrend(trend);
  const topDomains = summary?.top_blocked_domains || [];
  const topStudents = summary?.top_active_students || [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">DNS Statistics</h1>
          <p className="text-slate-500 text-sm mt-0.5">Aggregated from TimescaleDB continuous aggregate</p>
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => setPreset(p)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                ${preset.label === p.label ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
        {[
          { label: 'Total Queries', value: summary?.total,      color: 'text-blue-700',  bg: 'bg-blue-50' },
          { label: 'Allowed',       value: summary?.allowed,    color: 'text-green-700', bg: 'bg-green-50' },
          { label: 'Blocked',       value: summary?.blocked,    color: 'text-red-700',   bg: 'bg-red-50' },
          { label: 'Block Rate',    value: summary ? `${summary.block_rate}%` : null, color: 'text-slate-700', bg: 'bg-slate-50' },
          { label: 'Cache Hit Rate', value: summary?.cache_hit_rate != null ? `${summary.cache_hit_rate}%` : 'n/a',
            color: 'text-purple-700', bg: 'bg-purple-50' },
        ].map(c => (
          <div key={c.label} className={`${c.bg} rounded-xl p-4 border border-transparent`}>
            <div className={`text-2xl font-bold ${c.color}`}>
              {sLoading ? '…' : (typeof c.value === 'number' ? c.value.toLocaleString() : c.value) ?? '—'}
            </div>
            <div className="text-xs font-semibold text-slate-500 mt-0.5">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Trend chart */}
      <div className="card p-5 mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-4">Query Volume</h2>
        {tLoading ? (
          <div className="h-48 flex items-center justify-center text-slate-400 text-sm">Loading…</div>
        ) : chartData.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No data for this period</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gA" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gB" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} width={42} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="allowed" stroke="#22c55e" fill="url(#gA)" strokeWidth={2} />
              <Area type="monotone" dataKey="blocked" stroke="#ef4444" fill="url(#gB)" strokeWidth={2} />
              <Area type="monotone" dataKey="unknown" stroke="#94a3b8" fill="none" strokeDasharray="4 2" strokeWidth={1} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top blocked domains */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">Top Blocked Domains</h2>
          {topDomains.length === 0 ? (
            <div className="text-slate-400 text-sm py-6 text-center">No blocked queries in this period</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={topDomains.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 8 }}>
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="domain" tick={{ fontSize: 10 }} width={130} />
                <Tooltip />
                <Bar dataKey="count" fill="#ef4444" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Top active students */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">Most Active Students</h2>
          {topStudents.length === 0 ? (
            <div className="text-slate-400 text-sm py-6 text-center">No student data in this period</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={topStudents.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 8 }}>
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="student_name" tick={{ fontSize: 10 }} width={110} />
                <Tooltip />
                <Bar dataKey="count" fill="#3b82f6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
