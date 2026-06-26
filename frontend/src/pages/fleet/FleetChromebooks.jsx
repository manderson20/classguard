import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiHelpCircleOutline, mdiMonitor } from '@mdi/js';
import api from '../../lib/api';

const STATUS_TABS = [
  { value: '',         label: 'All'       },
  { value: 'expired',  label: 'Expired'   },
  { value: 'expiring', label: 'Expiring'  },
  { value: 'ok',       label: 'Supported' },
  { value: 'unknown',  label: 'Unknown'   },
];

function AupBadge({ status }) {
  const map = {
    expired:  { cls: 'bg-red-100 text-red-700',    label: 'AUP Expired'     },
    expiring: { cls: 'bg-amber-100 text-amber-700', label: 'Expiring < 1yr'  },
    ok:       { cls: 'bg-green-100 text-green-700', label: 'Supported'       },
    unknown:  { cls: 'bg-slate-100 text-slate-500', label: 'Unknown'         },
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

function ConfirmModal({ count, onConfirm, onCancel, loading, result }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900 flex items-center gap-2">
            <MdiIcon path={mdiAlertCircleOutline} size="1em" className="text-red-500" />
            Disable {count} Chromebook{count !== 1 ? 's' : ''}?
          </h2>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        <div className="px-6 py-4">
          {result ? (
            <div>
              <p className="text-sm text-green-700 font-medium mb-2">
                Disabled: {result.disabled}
              </p>
              {result.errors?.length > 0 && (
                <div className="text-sm text-red-600">
                  <p className="font-medium mb-1">Errors:</p>
                  <ul className="list-disc list-inside space-y-1 text-xs">
                    {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
              <button className="btn btn-primary mt-4 w-full" onClick={onCancel}>Close</button>
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-600 mb-4">
                This will disable {count} selected Chromebook{count !== 1 ? 's' : ''} in Google Admin.
                Students will not be able to sign in until you re-enable them.
              </p>
              <div className="flex gap-3">
                <button className="btn btn-secondary flex-1" onClick={onCancel} disabled={loading}>
                  Cancel
                </button>
                <button
                  className="btn flex-1 bg-red-600 hover:bg-red-700 text-white"
                  onClick={onConfirm}
                  disabled={loading}
                >
                  {loading ? 'Disabling…' : `Disable ${count} device${count !== 1 ? 's' : ''}`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FleetChromebooks() {
  const [statusFilter, setStatusFilter] = useState('');
  const [selected,     setSelected]     = useState(new Set());
  const [showConfirm,  setShowConfirm]  = useState(false);
  const [disableResult, setDisableResult] = useState(null);
  const qc = useQueryClient();

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['fleet-chromebooks', statusFilter],
    queryFn:  () => api.get(`/fleet/chromebooks${statusFilter ? `?status=${statusFilter}` : ''}`),
    staleTime: 30_000,
  });

  const disableMutation = useMutation({
    mutationFn: (deviceIds) => api.post('/fleet/chromebooks/disable', { deviceIds }),
    onSuccess: (result) => {
      setDisableResult(result);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['fleet-chromebooks'] });
      qc.invalidateQueries({ queryKey: ['fleet-summary'] });
    },
  });

  const toggleAll = () => {
    if (selected.size === devices.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(devices.map(d => d.googleDeviceId).filter(Boolean)));
    }
  };

  const toggleOne = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleDisable = () => {
    disableMutation.mutate([...selected]);
  };

  const handleCloseConfirm = () => {
    setShowConfirm(false);
    setDisableResult(null);
  };

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <MdiIcon path={mdiMonitor} size="1.2em" className="text-primary-600" />
            Chromebooks
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {devices.length > 0 ? `${devices.length.toLocaleString()} device${devices.length !== 1 ? 's' : ''}` : 'AUP status for all Chromebooks'}
          </p>
        </div>
        {selected.size > 0 && (
          <button
            className="btn flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white flex-shrink-0"
            onClick={() => setShowConfirm(true)}
          >
            <MdiIcon path={mdiAlertCircleOutline} size="1em" />
            Disable Selected ({selected.size})
          </button>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 flex-wrap">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => { setStatusFilter(tab.value); setSelected(new Set()); }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === tab.value
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {tab.label}
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
          <div className="p-12 text-center text-slate-400 text-sm">
            <MdiIcon path={mdiCheckCircleOutline} size="2em" className="mx-auto mb-2 opacity-30" />
            No Chromebooks in this category.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-4 py-2 text-left w-8">
                    <input
                      type="checkbox"
                      checked={selected.size === devices.filter(d => d.googleDeviceId).length && devices.filter(d => d.googleDeviceId).length > 0}
                      onChange={toggleAll}
                      className="rounded"
                    />
                  </th>
                  <th className="px-4 py-2 text-left">Device</th>
                  <th className="px-4 py-2 text-left">Serial</th>
                  <th className="px-4 py-2 text-left">Model</th>
                  <th className="px-4 py-2 text-left">AUP Date</th>
                  <th className="px-4 py-2 text-left">AUP Status</th>
                  <th className="px-4 py-2 text-left">OS Version</th>
                  <th className="px-4 py-2 text-left">Assigned</th>
                  <th className="px-4 py-2 text-left">Asset Tag</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {devices.map(d => (
                  <tr key={d.serialNumber} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(d.googleDeviceId)}
                        onChange={() => toggleOne(d.googleDeviceId)}
                        disabled={!d.googleDeviceId}
                        className="rounded"
                      />
                    </td>
                    <td className="px-4 py-2 font-medium text-slate-900">{d.deviceName || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.serialNumber}</td>
                    <td className="px-4 py-2 text-slate-600">{d.deviceModel || '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{fmtDate(d.aupDate)}</td>
                    <td className="px-4 py-2"><AupBadge status={d.aupStatus} /></td>
                    <td className="px-4 py-2 text-slate-600">{d.osVersion || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{d.assignedEmail || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{d.assetTag || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showConfirm && (
        <ConfirmModal
          count={selected.size}
          onConfirm={handleDisable}
          onCancel={handleCloseConfirm}
          loading={disableMutation.isPending}
          result={disableResult}
        />
      )}
    </div>
  );
}
