import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon as MdiIcon } from '@mdi/react';
import {
  mdiViewDashboardOutline,
  mdiMonitor,
  mdiWifiOff,
  mdiSync,
  mdiCalendarClock,
  mdiRefresh,
  mdiTablet,
} from '@mdi/js';
import api from '../../lib/api';

function fmtTime(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString();
}

function StatCard({ title, icon, children, to }) {
  const navigate = useNavigate();
  return (
    <div
      className={`card p-4 flex flex-col gap-2 ${to ? 'cursor-pointer hover:shadow-md transition-shadow' : ''}`}
      onClick={to ? () => navigate(to) : undefined}
    >
      <div className="flex items-center gap-2 text-slate-500 text-sm font-medium">
        <MdiIcon path={icon} size="1em" />
        {title}
      </div>
      {children}
    </div>
  );
}

function OsBar({ label, count, total, color }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-500 w-20 text-right flex-shrink-0">{label}</span>
      <div className="flex-1 bg-slate-100 rounded-full h-2.5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-semibold text-slate-700 w-10 flex-shrink-0">{count.toLocaleString()}</span>
      <span className="text-xs text-slate-400 w-8 flex-shrink-0">{pct}%</span>
    </div>
  );
}

const OS_COLORS = {
  ChromeOS: 'bg-blue-500',
  macOS: 'bg-purple-500',
  iOS: 'bg-green-500',
  iPadOS: 'bg-amber-500',
};

export default function FleetOverview() {
  const { data, isLoading } = useQuery({
    queryKey: ['fleet-summary'],
    queryFn: () => api.get('/fleet/summary'),
    staleTime: 60_000,
  });

  const byOs  = data?.byOs  || {};
  const total = data?.total || 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <MdiIcon path={mdiViewDashboardOutline} size="1.2em" className="text-primary-600" />
          Device Fleet
        </h1>
        <p className="text-slate-500 text-sm mt-0.5">Overview of all managed devices across integrations</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card p-4 animate-pulse">
              <div className="h-4 bg-slate-100 rounded mb-3 w-32" />
              <div className="h-8 bg-slate-100 rounded w-20" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Stat cards — 2×3 grid */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {/* Total Devices */}
            <StatCard title="Total Devices" icon={mdiMonitor} to="/fleet/devices">
              <div className="text-3xl font-bold text-slate-900">{total.toLocaleString()}</div>
              <div className="text-xs text-slate-400">across all sources</div>
            </StatCard>

            {/* Chromebook AUP */}
            <StatCard title="Chromebook AUP" icon={mdiMonitor} to="/fleet/chromebooks">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-2xl font-bold text-red-600">{data?.chromebooks?.expired ?? 0}</span>
                <span className="text-xs text-red-500">expired</span>
              </div>
              <div className="flex gap-3 text-xs mt-1 flex-wrap">
                <span className="text-amber-600 font-semibold">{data?.chromebooks?.expiringSoon ?? 0} expiring</span>
                <span className="text-green-600 font-semibold">{data?.chromebooks?.ok ?? 0} ok</span>
                <span className="text-slate-400">{data?.chromebooks?.unknown ?? 0} unknown</span>
              </div>
            </StatCard>

            {/* Apple OS Status */}
            <StatCard title="Apple OS Status" icon={mdiTablet} to="/fleet/apple">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-2xl font-bold text-green-600">{data?.apple?.upToDate ?? 0}</span>
                <span className="text-xs text-green-500">up to date</span>
              </div>
              <div className="flex gap-3 text-xs mt-1 flex-wrap">
                <span className="text-amber-600 font-semibold">{data?.apple?.updateAvailable ?? 0} updates available</span>
                <span className="text-slate-400">{data?.apple?.unknown ?? 0} unknown</span>
              </div>
            </StatCard>

            {/* Offline Devices */}
            <StatCard title="Offline Devices" icon={mdiWifiOff} to="/fleet/offline">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-amber-600">{data?.offline ?? 0}</span>
                <span className="text-xs text-slate-400">not seen 30+ days</span>
              </div>
            </StatCard>

            {/* Cross-Sync Gaps */}
            <StatCard title="Cross-Sync Gaps" icon={mdiSync} to="/fleet/cross-sync">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-slate-700">{data?.gaps ?? 0}</span>
                <span className="text-xs text-slate-400">not in Snipe-IT</span>
              </div>
            </StatCard>

            {/* Lifecycle */}
            <StatCard title="Lifecycle" icon={mdiCalendarClock} to="/fleet/lifecycle">
              <div className="text-sm text-slate-600">AUP and warranty status</div>
              <div className="text-xs text-slate-400 mt-1">across all platforms</div>
            </StatCard>
          </div>

          {/* OS Breakdown */}
          <div className="card p-4 mb-6">
            <h2 className="text-sm font-semibold text-slate-700 mb-4">Device Breakdown by OS</h2>
            <div className="space-y-3">
              {Object.entries(byOs).map(([os, count]) => (
                <OsBar key={os} label={os} count={count} total={total} color={OS_COLORS[os] || 'bg-slate-400'} />
              ))}
              {Object.keys(byOs).length === 0 && (
                <p className="text-sm text-slate-400 text-center py-4">No data yet — run a sync to populate.</p>
              )}
            </div>
          </div>

          {/* Last sync times */}
          <div className="card p-4">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Last Sync Times</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-xs text-slate-400 mb-0.5">Mosyle</div>
                <div className="font-medium text-slate-700">{fmtTime(data?.lastSync?.mosyle)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400 mb-0.5">Snipe-IT</div>
                <div className="font-medium text-slate-700">{fmtTime(data?.lastSync?.snipeit)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400 mb-0.5">Google Devices</div>
                <div className="font-medium text-slate-700">{fmtTime(data?.lastSync?.googleDevices)}</div>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-slate-100">
              <button
                className="btn btn-secondary btn-sm flex items-center gap-1.5"
                onClick={() => window.location.href = '/fleet/cross-sync'}
              >
                <MdiIcon path={mdiRefresh} size="0.9em" />
                Go to Cross-System Sync
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
