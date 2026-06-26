import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import {
  mdiSync,
  mdiPencil,
  mdiMagnify,
  mdiCheckCircleOutline,
  mdiAlertCircleOutline,
} from '@mdi/js';
import api from '../../lib/api';

function useDebounced(value, delay = 300) {
  const [d, setD] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setD(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return d;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
function SettingsModal({ current, onClose }) {
  const qc = useQueryClient();
  const [modelSearch,  setModelSearch]  = useState('');
  const [selectedModel, setSelectedModel] = useState(current?.defaultModelId ? { id: current.defaultModelId, name: current.defaultModelName } : null);
  const [selectedStatus, setSelectedStatus] = useState(current?.defaultStatusId ? { id: current.defaultStatusId, name: current.defaultStatusName } : null);
  const mq = useDebounced(modelSearch);

  const { data: models = [] } = useQuery({
    queryKey: ['fleet-snipeit-models', mq],
    queryFn:  () => api.get(`/fleet/cross-sync/snipeit-models?q=${encodeURIComponent(mq)}`),
    staleTime: 30_000,
  });

  const { data: statuses = [] } = useQuery({
    queryKey: ['fleet-snipeit-statuses'],
    queryFn:  () => api.get('/fleet/cross-sync/snipeit-statuses'),
    staleTime: 60_000,
  });

  const saveMutation = useMutation({
    mutationFn: (body) => api.post('/fleet/cross-sync/settings', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fleet-cross-sync-settings'] });
      onClose();
    },
  });

  const handleSave = () => {
    if (!selectedModel || !selectedStatus) return;
    saveMutation.mutate({ defaultModelId: selectedModel.id, defaultStatusId: selectedStatus.id });
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">Cross-Sync Settings</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {/* Model selector */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Default Snipe-IT Model (for new records)
            </label>
            <div className="relative mb-2">
              <MdiIcon path={mdiMagnify} size="1em" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                className="input w-full pl-9"
                placeholder="Search models…"
                value={modelSearch}
                onChange={e => setModelSearch(e.target.value)}
              />
            </div>
            <div className="border border-slate-200 rounded-lg max-h-40 overflow-y-auto">
              {models.length === 0 && (
                <div className="p-3 text-xs text-slate-400 text-center">
                  {mq ? 'No models found.' : 'Type to search models…'}
                </div>
              )}
              {models.map(m => (
                <button
                  key={m.id}
                  onClick={() => setSelectedModel(m)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-50 transition-colors ${
                    selectedModel?.id === m.id ? 'bg-primary-50 text-primary-700 font-medium' : 'text-slate-700'
                  }`}
                >
                  {m.name}
                </button>
              ))}
            </div>
            {selectedModel && (
              <p className="text-xs text-primary-600 mt-1">Selected: {selectedModel.name}</p>
            )}
          </div>

          {/* Status selector */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Default Snipe-IT Status (for new records)
            </label>
            <select
              className="input w-full"
              value={selectedStatus?.id || ''}
              onChange={e => {
                const s = statuses.find(s => String(s.id) === e.target.value);
                setSelectedStatus(s || null);
              }}
            >
              <option value="">Select status…</option>
              {statuses.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
          <button className="btn btn-secondary flex-1" onClick={onClose} disabled={saveMutation.isPending}>Cancel</button>
          <button
            className="btn btn-primary flex-1"
            onClick={handleSave}
            disabled={saveMutation.isPending || !selectedModel || !selectedStatus}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function FleetCrossSync() {
  const [showSettings, setShowSettings] = useState(false);
  const [syncResult,   setSyncResult]   = useState(null);
  const [syncing,      setSyncing]      = useState(false);
  const qc = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['fleet-cross-sync-settings'],
    queryFn:  () => api.get('/fleet/cross-sync/settings'),
    staleTime: 60_000,
  });

  const { data: gaps = [], isLoading: gapsLoading } = useQuery({
    queryKey: ['fleet-cross-sync-gaps'],
    queryFn:  () => api.get('/fleet/cross-sync/gaps'),
    staleTime: 30_000,
  });

  const { data: history = [], isLoading: histLoading } = useQuery({
    queryKey: ['fleet-cross-sync-history'],
    queryFn:  () => api.get('/fleet/cross-sync/history'),
    staleTime: 30_000,
  });

  const runSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await api.post('/fleet/cross-sync/run');
      setSyncResult(result);
      qc.invalidateQueries({ queryKey: ['fleet-cross-sync-gaps'] });
      qc.invalidateQueries({ queryKey: ['fleet-cross-sync-history'] });
      qc.invalidateQueries({ queryKey: ['fleet-summary'] });
    } catch (err) {
      setSyncResult({ error: err.message || 'Sync failed.' });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <MdiIcon path={mdiSync} size="1.2em" className="text-primary-600" />
          Cross-System Sync
        </h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Keep Google Admin, Mosyle, and Snipe-IT in sync
        </p>
      </div>

      {/* Settings card */}
      <div className="card p-4 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Snipe-IT Default Settings</h2>
            {settings ? (
              <div className="flex gap-6 text-sm text-slate-600">
                <div>
                  <span className="text-xs text-slate-400 block">Default Model</span>
                  <span className="font-medium">{settings.defaultModelName || '—'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400 block">Default Status</span>
                  <span className="font-medium">{settings.defaultStatusName || '—'}</span>
                </div>
              </div>
            ) : (
              <div className="animate-pulse h-8 bg-slate-100 rounded w-48" />
            )}
          </div>
          <button
            className="btn btn-secondary btn-sm flex items-center gap-1.5 flex-shrink-0"
            onClick={() => setShowSettings(true)}
          >
            <MdiIcon path={mdiPencil} size="0.9em" />
            Edit
          </button>
        </div>
      </div>

      {/* Gaps + Run Sync */}
      <div className="card p-4 mb-6">
        <div className="flex items-center justify-between mb-4 gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Sync Gaps</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Devices in MDM (Google/Mosyle) that are missing from Snipe-IT
            </p>
          </div>
          <button
            className="btn btn-primary flex items-center gap-1.5 flex-shrink-0"
            onClick={runSync}
            disabled={syncing}
          >
            {syncing ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Syncing…
              </>
            ) : (
              <>
                <MdiIcon path={mdiSync} size="1em" />
                Run Cross-Sync
              </>
            )}
          </button>
        </div>

        {/* Sync result summary */}
        {syncResult && !syncResult.error && (
          <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
            <div className="flex items-center gap-2 mb-2 text-green-700 font-medium text-sm">
              <MdiIcon path={mdiCheckCircleOutline} size="1em" />
              Sync complete
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div className="text-center">
                <div className="text-xl font-bold text-green-700">{syncResult.createdInSnipeit}</div>
                <div className="text-xs text-slate-500">Created in Snipe-IT</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold text-blue-700">{syncResult.wroteBackToGoogle}</div>
                <div className="text-xs text-slate-500">Google writeback</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold text-purple-700">{syncResult.wroteBackToMosyle}</div>
                <div className="text-xs text-slate-500">Mosyle writeback</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold text-slate-500">{syncResult.skipped}</div>
                <div className="text-xs text-slate-500">Skipped</div>
              </div>
            </div>
            {syncResult.errors?.length > 0 && (
              <div className="mt-3 text-xs text-red-600">
                <p className="font-medium">Errors:</p>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  {syncResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
            <p className="text-xs text-slate-400 mt-2 italic">
              Note: Mosyle write-back records the asset tag in ClassGuard — set it manually in Mosyle if you need it there.
            </p>
          </div>
        )}
        {syncResult?.error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-sm">
            <MdiIcon path={mdiAlertCircleOutline} size="1em" />
            {syncResult.error}
          </div>
        )}

        {/* Gaps table */}
        {gapsLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => <div key={i} className="animate-pulse h-8 bg-slate-100 rounded" />)}
          </div>
        ) : gaps.length === 0 ? (
          <div className="py-8 text-center text-slate-400 text-sm">
            <MdiIcon path={mdiCheckCircleOutline} size="2em" className="mx-auto mb-2 opacity-30" />
            No sync gaps — all devices are in Snipe-IT.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-3 py-2 text-left">Serial</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Model</th>
                  <th className="px-3 py-2 text-left">OS</th>
                  <th className="px-3 py-2 text-left">Present In</th>
                  <th className="px-3 py-2 text-left">Missing From</th>
                  <th className="px-3 py-2 text-left">Asset Tag</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {gaps.map(g => (
                  <tr key={g.serial} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">{g.serial}</td>
                    <td className="px-3 py-2 text-slate-900">{g.deviceName || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{g.deviceModel || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{g.osType || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(g.presentIn || []).map(s => (
                          <span key={s} className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">{s}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(g.missingFrom || []).map(s => (
                          <span key={s} className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">{s}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{g.assetTag || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* History */}
      <div className="card p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-4">Sync History</h2>
        {histLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => <div key={i} className="animate-pulse h-8 bg-slate-100 rounded" />)}
          </div>
        ) : history.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">No sync runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-left">Created</th>
                  <th className="px-3 py-2 text-left">Google WB</th>
                  <th className="px-3 py-2 text-left">Mosyle WB</th>
                  <th className="px-3 py-2 text-left">Skipped</th>
                  <th className="px-3 py-2 text-left">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.map(h => (
                  <tr key={h.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-xs text-slate-600">{fmtDate(h.run_at)}</td>
                    <td className="px-3 py-2 text-slate-700 font-medium">{h.created_in_snipeit}</td>
                    <td className="px-3 py-2 text-slate-700">{h.wrote_back_to_google}</td>
                    <td className="px-3 py-2 text-slate-700">{h.wrote_back_to_mosyle}</td>
                    <td className="px-3 py-2 text-slate-500">{h.skipped}</td>
                    <td className="px-3 py-2">
                      {h.errors?.length > 0 ? (
                        <span className="text-xs text-red-600 font-medium">{h.errors.length} error{h.errors.length !== 1 ? 's' : ''}</span>
                      ) : (
                        <span className="text-xs text-green-600">None</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showSettings && (
        <SettingsModal current={settings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
