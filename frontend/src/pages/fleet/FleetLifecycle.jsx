import { useQuery } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import { mdiCalendarClock } from '@mdi/js';
import api from '../../lib/api';

function AupBadge({ status }) {
  const map = {
    expired:  { cls: 'bg-red-100 text-red-700',    label: 'AUP Expired'    },
    expiring: { cls: 'bg-amber-100 text-amber-700', label: 'Expiring < 1yr' },
    ok:       { cls: 'bg-green-100 text-green-700', label: 'Supported'      },
    unknown:  { cls: 'bg-slate-100 text-slate-500', label: 'Unknown'        },
  };
  const { cls, label } = map[status] || map.unknown;
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>{label}</span>;
}

function WarrantyBadge({ status }) {
  const map = {
    ok:      { cls: 'bg-green-100 text-green-700', label: 'Covered'  },
    expired: { cls: 'bg-red-100 text-red-700',     label: 'Expired'  },
    none:    { cls: 'bg-slate-100 text-slate-500',  label: 'No Data' },
  };
  const { cls, label } = map[status] || map.none;
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>{label}</span>;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

// Sort: expired warranty+AUP first, then expiring, then ok/unknown
function urgencyScore(d) {
  let score = 0;
  if (d.warrantyStatus === 'expired') score += 10;
  if (d.aupStatus     === 'expired') score += 5;
  if (d.warrantyStatus === 'ok')     score -= 2;
  if (d.aupStatus     === 'expiring') score += 3;
  return score;
}

export default function FleetLifecycle() {
  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['fleet-lifecycle'],
    queryFn:  () => api.get('/fleet/lifecycle'),
    staleTime: 60_000,
  });

  const sorted = [...devices].sort((a, b) => urgencyScore(b) - urgencyScore(a));

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <MdiIcon path={mdiCalendarClock} size="1.2em" className="text-primary-600" />
          Lifecycle &amp; Warranty
        </h1>
        <p className="text-slate-500 text-sm mt-0.5">
          {sorted.length > 0
            ? `${sorted.length.toLocaleString()} device${sorted.length !== 1 ? 's' : ''} — sorted by urgency`
            : 'AUP and warranty status for all devices'}
        </p>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-3">
            {[...Array(10)].map((_, i) => (
              <div key={i} className="animate-pulse h-8 bg-slate-100 rounded" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">
            <MdiIcon path={mdiCalendarClock} size="2em" className="mx-auto mb-2 opacity-30" />
            No lifecycle data available. Run a sync to populate.
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
                  <th className="px-4 py-2 text-left">AUP Date</th>
                  <th className="px-4 py-2 text-left">AUP Status</th>
                  <th className="px-4 py-2 text-left">Purchase Date</th>
                  <th className="px-4 py-2 text-left">Warranty Exp.</th>
                  <th className="px-4 py-2 text-left">Warranty</th>
                  <th className="px-4 py-2 text-left">Assigned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sorted.map(d => (
                  <tr
                    key={d.serialNumber}
                    className={`transition-colors ${
                      d.warrantyStatus === 'expired' && d.aupStatus === 'expired'
                        ? 'bg-red-50 hover:bg-red-100'
                        : d.warrantyStatus === 'expired' || d.aupStatus === 'expired'
                          ? 'bg-red-50/50 hover:bg-red-50'
                          : d.aupStatus === 'expiring'
                            ? 'bg-amber-50 hover:bg-amber-100'
                            : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="px-4 py-2 font-medium text-slate-900">{d.deviceName || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.serialNumber}</td>
                    <td className="px-4 py-2 text-slate-600">{d.deviceModel || '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{d.osType || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{fmtDate(d.aupDate)}</td>
                    <td className="px-4 py-2"><AupBadge status={d.aupStatus} /></td>
                    <td className="px-4 py-2 text-xs text-slate-600">{fmtDate(d.purchaseDate)}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{fmtDate(d.warrantyExpires)}</td>
                    <td className="px-4 py-2"><WarrantyBadge status={d.warrantyStatus} /></td>
                    <td className="px-4 py-2 text-xs text-slate-600">{d.assignedEmail || '—'}</td>
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
