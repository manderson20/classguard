import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

function timeAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function LostModePage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);

  const { data: results = [] } = useQuery({
    queryKey: ['lost-mode-search', search],
    queryFn: () => api.get(`/lost-mode/search?q=${encodeURIComponent(search)}`),
    enabled: search.length >= 2,
  });

  const { data: device } = useQuery({
    queryKey: ['lost-mode-device', selectedKey],
    queryFn: () => api.get(`/lost-mode/${encodeURIComponent(selectedKey)}`),
    enabled: !!selectedKey,
  });

  const runAction = useMutation({
    mutationFn: (action) => api.post(`/lost-mode/${encodeURIComponent(selectedKey)}/action`, { action }),
    onSuccess: () => { setActionError(null); setConfirmAction(null); qc.invalidateQueries({ queryKey: ['lost-mode-device', selectedKey] }); },
    onError: (err) => { setActionError(err.message); setConfirmAction(null); },
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Chromebook Lost Mode</h1>
      <p className="text-slate-500 text-sm mb-6">
        Search for a device to see its last known signal and, if it's a Chromebook, lock or unlock it remotely.
        There's no GPS/location tracking available — Google doesn't expose that for Chromebooks. What's shown below is
        the best real signal available: which access point it's currently on (if connected to school WiFi right now)
        and its last-known IP address and sync time (even if it's since gone offline).
      </p>

      <input
        type="text"
        className="input w-full mb-4"
        placeholder="Search by name, serial number, or assigned email…"
        value={search}
        onChange={e => { setSearch(e.target.value); setSelectedKey(null); }}
      />

      {!selectedKey && results.length > 0 && (
        <div className="card divide-y divide-slate-50 mb-6">
          {results.map(d => (
            <button
              key={d.key}
              onClick={() => setSelectedKey(d.key)}
              className="w-full text-left px-4 py-3 hover:bg-slate-50 flex items-center justify-between"
            >
              <div>
                <div className="font-medium text-sm text-slate-800">{d.assignedUser || d.serialNumber || d.key}</div>
                <div className="text-xs text-slate-400">{d.deviceModel || '—'} · {d.serialNumber || 'no serial'}</div>
              </div>
              {d.network ? (
                <span className="badge-green text-xs">Online</span>
              ) : (
                <span className="badge-slate text-xs">Offline</span>
              )}
            </button>
          ))}
        </div>
      )}

      {selectedKey && device && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold text-slate-900">{device.assignedUser || device.serialNumber}</div>
              <div className="text-xs text-slate-400">{device.deviceModel} · {device.serialNumber}</div>
            </div>
            <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setSelectedKey(null)}>← Back to search</button>
          </div>

          <div className="border-t border-slate-100 pt-3">
            <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Last Known Signal</div>
            {device.network ? (
              <div className="text-sm space-y-1">
                <div className="flex items-center gap-2">
                  <span className="badge-green text-xs">Currently online</span>
                  <span className="text-slate-600">via access point <strong>{device.network.apName || 'unknown'}</strong></span>
                </div>
                <div className="text-xs text-slate-500">SSID: {device.network.ssid || '—'} · IP: {device.network.ip || '—'} · seen {timeAgo(device.network.lastSeen)}</div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">
                Not currently connected to school WiFi.
                {device.ipAddresses?.length > 0 && (
                  <div className="text-xs mt-1">Last known IP (from Google sync): <span className="font-mono">{device.ipAddresses.join(', ')}</span>{device.lastSynced && <> · synced {timeAgo(device.lastSynced)}</>}</div>
                )}
              </div>
            )}
          </div>

          {device.googleDeviceId ? (
            <div className="border-t border-slate-100 pt-3">
              <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Lock / Unlock</div>
              <p className="text-xs text-slate-500 mb-2">
                Disabling shows a black lock screen with whatever message is configured once in Google Admin Console
                (Devices › Chrome › Settings › Device › Device disabling) — ClassGuard can't set a different message
                per incident, that's a Google limitation, not ours.
              </p>
              {actionError && <p className="text-xs text-red-600 mb-2">{actionError}</p>}
              {!confirmAction ? (
                <div className="flex gap-2">
                  <button className="btn-secondary text-sm text-red-600" onClick={() => setConfirmAction('disable')}>Disable Device</button>
                  <button className="btn-secondary text-sm" onClick={() => setConfirmAction('reenable')}>Re-enable Device</button>
                </div>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded p-3 space-y-2">
                  <p className="text-sm text-amber-800">
                    {confirmAction === 'disable'
                      ? 'This will immediately lock this device with a black disable screen. Confirm?'
                      : 'This will restore normal use of this device. Confirm?'}
                  </p>
                  <div className="flex gap-2">
                    <button
                      className="btn-primary text-sm"
                      disabled={runAction.isPending}
                      onClick={() => runAction.mutate(confirmAction)}
                    >
                      {runAction.isPending ? 'Working…' : `Yes, ${confirmAction}`}
                    </button>
                    <button className="text-xs text-slate-500" onClick={() => setConfirmAction(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="border-t border-slate-100 pt-3 text-xs text-slate-400">
              No Google Admin record for this device — lock/unlock only works for Chromebooks managed in Google Workspace.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
