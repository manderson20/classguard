import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import { mdiTablet, mdiPencil } from '@mdi/js';
import api from '../../lib/api';

const OS_TABS = [
  { value: '',      label: 'All'     },
  { value: 'macOS', label: 'macOS'   },
  { value: 'iOS',   label: 'iOS'     },
  { value: 'iPadOS', label: 'iPadOS' },
];

function UpdateBadge({ status }) {
  const map = {
    upToDate: { cls: 'bg-green-100 text-green-700',   label: 'Up to Date'       },
    behind:   { cls: 'bg-amber-100 text-amber-700',   label: 'Update Available' },
    unknown:  { cls: 'bg-slate-100 text-slate-500',   label: 'Unknown'          },
  };
  const { cls, label } = map[status] || map.unknown;
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

function OsRefModal({ onClose }) {
  const qc = useQueryClient();
  const { data: refs = [], isLoading } = useQuery({
    queryKey: ['fleet-apple-os-ref'],
    queryFn:  () => api.get('/fleet/apple/os-reference'),
    staleTime: 60_000,
  });

  const [edits, setEdits] = useState({});

  const updateMutation = useMutation({
    mutationFn: ({ family, latest_version, min_supported_version }) =>
      api.put(`/fleet/apple/os-reference/${encodeURIComponent(family)}`, { latest_version, min_supported_version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fleet-apple-os-ref'] });
      qc.invalidateQueries({ queryKey: ['fleet-apple'] });
    },
  });

  const getEdit = (family, field, fallback) =>
    edits[family]?.[field] !== undefined ? edits[family][field] : fallback;

  const setEdit = (family, field, value) =>
    setEdits(prev => ({ ...prev, [family]: { ...prev[family], [field]: value } }));

  const handleSave = (ref) => {
    const latest  = getEdit(ref.os_family, 'latest_version',       ref.latest_version);
    const minSup  = getEdit(ref.os_family, 'min_supported_version', ref.min_supported_version);
    updateMutation.mutate({ family: ref.os_family, latest_version: latest, min_supported_version: minSup });
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">Update OS Reference Versions</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {isLoading && (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => <div key={i} className="animate-pulse h-16 bg-slate-100 rounded" />)}
            </div>
          )}
          {!isLoading && refs.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-4">No OS reference data available.</p>
          )}
          {refs.map(ref => (
            <div key={ref.os_family} className="border border-slate-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="font-semibold text-slate-900">{ref.os_family}</span>
                {ref.notes && <span className="text-xs text-slate-400">{ref.notes}</span>}
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-500">Latest Version</span>
                  <input
                    type="text"
                    className="input w-full"
                    value={getEdit(ref.os_family, 'latest_version', ref.latest_version || '')}
                    onChange={e => setEdit(ref.os_family, 'latest_version', e.target.value)}
                    placeholder="e.g. 14.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-500">Min Supported Version</span>
                  <input
                    type="text"
                    className="input w-full"
                    value={getEdit(ref.os_family, 'min_supported_version', ref.min_supported_version || '')}
                    onChange={e => setEdit(ref.os_family, 'min_supported_version', e.target.value)}
                    placeholder="e.g. 12.0"
                  />
                </label>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleSave(ref)}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          ))}
        </div>
        <div className="px-6 py-4 border-t border-slate-100">
          <button className="btn btn-secondary w-full" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export default function FleetApple() {
  const [osFilter,      setOsFilter]      = useState('');
  const [updateFilter,  setUpdateFilter]  = useState('');
  const [showRefModal,  setShowRefModal]  = useState(false);

  const params = new URLSearchParams();
  if (osFilter)     params.set('os',           osFilter);
  if (updateFilter) params.set('updateStatus', updateFilter);

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['fleet-apple', osFilter, updateFilter],
    queryFn:  () => api.get(`/fleet/apple?${params.toString()}`),
    staleTime: 30_000,
  });

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <MdiIcon path={mdiTablet} size="1.2em" className="text-primary-600" />
            Apple Devices
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {devices.length > 0 ? `${devices.length.toLocaleString()} device${devices.length !== 1 ? 's' : ''}` : 'macOS, iOS, and iPadOS devices from Mosyle'}
          </p>
        </div>
        <button
          className="btn btn-secondary flex items-center gap-1.5 flex-shrink-0"
          onClick={() => setShowRefModal(true)}
        >
          <MdiIcon path={mdiPencil} size="0.9em" />
          Update Reference Versions
        </button>
      </div>

      {/* OS tabs */}
      <div className="flex gap-1 mb-3 flex-wrap">
        {OS_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => setOsFilter(tab.value)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              osFilter === tab.value
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Update status filter */}
      <div className="flex gap-2 mb-4 items-center">
        <span className="text-xs text-slate-500">Update status:</span>
        {[{ value: '', label: 'All' }, { value: 'upToDate', label: 'Up to Date' }, { value: 'behind', label: 'Behind' }, { value: 'unknown', label: 'Unknown' }].map(opt => (
          <button
            key={opt.value}
            onClick={() => setUpdateFilter(opt.value)}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              updateFilter === opt.value
                ? 'bg-slate-700 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse h-8 bg-slate-100 rounded" />
            ))}
          </div>
        ) : devices.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">No Apple devices match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-4 py-2 text-left">Device</th>
                  <th className="px-4 py-2 text-left">Serial</th>
                  <th className="px-4 py-2 text-left">Model</th>
                  <th className="px-4 py-2 text-left">OS</th>
                  <th className="px-4 py-2 text-left">Current Ver.</th>
                  <th className="px-4 py-2 text-left">Latest Ver.</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-left">Assigned</th>
                  <th className="px-4 py-2 text-left">Asset Tag</th>
                  <th className="px-4 py-2 text-left">Last Sync</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {devices.map(d => (
                  <tr key={d.serialNumber} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2 font-medium text-slate-900">{d.deviceName || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.serialNumber}</td>
                    <td className="px-4 py-2 text-slate-600">{d.deviceModel || '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{d.osType || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.osVersion || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.latestVersion || '—'}</td>
                    <td className="px-4 py-2"><UpdateBadge status={d.updateStatus} /></td>
                    <td className="px-4 py-2 text-xs text-slate-600">{d.assignedEmail || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{d.assetTag || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{fmtDate(d.lastSync)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showRefModal && <OsRefModal onClose={() => setShowRefModal(false)} />}
    </div>
  );
}
