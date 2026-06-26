import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import { mdiWifiOff } from '@mdi/js';

import api from '../../lib/api';

const DAY_OPTIONS = [7, 14, 30, 60, 90];

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
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

export default function FleetOffline() {
  const [days, setDays] = useState(30);

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['fleet-offline', days],
    queryFn:  () => api.get(`/fleet/offline?days=${days}`),
    staleTime: 60_000,
  });

  // Sort by daysSince descending (most offline first)
  const sorted = [...devices].sort((a, b) => (b.daysSince || 0) - (a.daysSince || 0));

  const rowClass = (d) => {
    if (d.daysSince > 60) return 'bg-red-50 hover:bg-red-100';
    if (d.daysSince > 30) return 'bg-amber-50 hover:bg-amber-100';
    return 'hover:bg-slate-50';
  };

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <MdiIcon path={mdiWifiOff} size="1.2em" className="text-primary-600" />
            Offline Devices
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {sorted.length > 0
              ? `${sorted.length.toLocaleString()} device${sorted.length !== 1 ? 's' : ''} not seen in the last ${days} days`
              : `Devices not seen in the last ${days} days`}
          </p>
        </div>

        {/* Days selector */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">Not seen in:</span>
          <div className="flex gap-1">
            {DAY_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  days === d
                    ? 'bg-primary-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 mb-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded bg-red-100 border border-red-200" />
          60+ days offline
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded bg-amber-100 border border-amber-200" />
          30–60 days offline
        </span>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse h-8 bg-slate-100 rounded" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">
            <MdiIcon path={mdiWifiOff} size="2em" className="mx-auto mb-2 opacity-30" />
            No devices offline for more than {days} days.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-4 py-2 text-left">Device</th>
                  <th className="px-4 py-2 text-left">Serial</th>
                  <th className="px-4 py-2 text-left">Model</th>
                  <th className="px-4 py-2 text-left">OS</th>
                  <th className="px-4 py-2 text-left">Assigned</th>
                  <th className="px-4 py-2 text-left">Last Seen</th>
                  <th className="px-4 py-2 text-left">Days Offline</th>
                  <th className="px-4 py-2 text-left">Sources</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {sorted.map(d => (
                  <tr key={d.serialNumber} className={`transition-colors ${rowClass(d)}`}>
                    <td className="px-4 py-2 font-medium text-slate-900">{d.deviceName || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.serialNumber}</td>
                    <td className="px-4 py-2 text-slate-600">{d.deviceModel || '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{d.osType || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{d.assignedEmail || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{fmtDate(d.lastSeen)}</td>
                    <td className="px-4 py-2">
                      <span className={`font-semibold ${d.daysSince > 60 ? 'text-red-700' : d.daysSince > 30 ? 'text-amber-700' : 'text-slate-700'}`}>
                        {d.daysSince ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(d.sources || []).map(s => (
                          <SourceBadge key={s} source={s} />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
