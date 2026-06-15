import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';

function StratumBadge({ stratum }) {
  if (stratum == null) return <span className="text-slate-400 text-xs">—</span>;
  const color = stratum <= 1 ? 'purple' : stratum <= 3 ? 'green' : stratum <= 5 ? 'yellow' : 'red';
  return <span className={`px-2 py-0.5 rounded text-xs font-semibold bg-${color}-100 text-${color}-700`}>Stratum {stratum}</span>;
}

function OffsetBar({ ms }) {
  if (ms == null) return <span className="text-slate-400 text-xs">—</span>;
  const abs   = Math.abs(ms);
  const color = abs < 10 ? 'green' : abs < 100 ? 'yellow' : 'red';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full bg-${color}-400 rounded-full`} style={{width:`${Math.min(abs/10,100)}%`}}/>
      </div>
      <span className="text-xs font-mono text-slate-600">{ms > 0 ? '+' : ''}{ms.toFixed(2)}ms</span>
    </div>
  );
}

export default function NtpPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ address:'', description:'', prefer: false });
  const [showAdd, setShowAdd] = useState(false);
  const [polling, setPolling] = useState(false);

  const { data: ntpData = {}, isLoading } = useQuery({
    queryKey: ['ntp-status'],
    queryFn:  () => api.get('/ntp/status'),
    refetchInterval: 60_000,
  });

  const { data: servers = [] } = useQuery({
    queryKey: ['ntp-servers'],
    queryFn:  () => api.get('/ntp/servers'),
  });

  const addServer = useMutation({
    mutationFn: () => api.post('/ntp/servers', form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ntp-servers'] });
      qc.invalidateQueries({ queryKey: ['ntp-status'] });
      setShowAdd(false);
      setForm({ address:'', description:'', prefer: false });
    },
  });

  const delServer = useMutation({
    mutationFn: id => api.delete(`/ntp/servers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ntp-servers'] });
      qc.invalidateQueries({ queryKey: ['ntp-status'] });
    },
  });

  const poll = async () => {
    setPolling(true);
    try { await api.post('/ntp/poll'); qc.invalidateQueries({ queryKey: ['ntp-status'] }); }
    finally { setPolling(false); }
  };

  const results  = ntpData.results  || [];
  const synced   = ntpData.synced;
  const minStrat = ntpData.min_stratum;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">NTP Monitoring</h1>
          <p className="text-slate-500 text-sm mt-0.5">Time synchronization status for all configured NTP servers</p>
        </div>
        <div className="flex gap-2">
          <button onClick={poll} disabled={polling}
            className="btn-secondary text-sm disabled:opacity-50">
            {polling ? 'Polling…' : 'Poll Now'}
          </button>
          <button onClick={()=>setShowAdd(v=>!v)} className="btn-primary text-sm">+ Add Server</button>
        </div>
      </div>

      {/* Status banner */}
      <div className={`rounded-xl p-4 mb-5 flex items-center gap-4
        ${synced ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}`}>
        <span className="text-2xl">{synced ? '✅' : '⚠️'}</span>
        <div>
          <div className={`font-semibold text-sm ${synced ? 'text-green-800' : 'text-yellow-800'}`}>
            {synced ? 'NTP Synchronized' : 'NTP Sync Unknown or Degraded'}
          </div>
          <div className={`text-xs mt-0.5 ${synced ? 'text-green-700' : 'text-yellow-700'}`}>
            {synced
              ? `Best stratum: ${minStrat ?? '—'} · ${results.filter(r=>r.reachable).length} / ${results.length} servers reachable`
              : 'No reachable NTP servers detected, or no poll has been run yet.'}
          </div>
        </div>
      </div>

      {/* Add server form */}
      {showAdd && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4 shadow-sm">
          <h3 className="font-semibold text-slate-800 mb-3 text-sm">Add NTP Server</h3>
          <div className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-40">
              <label className="text-xs font-medium text-slate-600 block mb-1">Hostname / IP</label>
              <input className={INPUT} placeholder="time.cloudflare.com" value={form.address}
                onChange={e=>setForm(f=>({...f,address:e.target.value}))}/>
            </div>
            <div className="flex-1 min-w-40">
              <label className="text-xs font-medium text-slate-600 block mb-1">Description</label>
              <input className={INPUT} placeholder="Optional label" value={form.description}
                onChange={e=>setForm(f=>({...f,description:e.target.value}))}/>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-1 text-xs text-slate-600 mb-1.5">
                <input type="checkbox" checked={form.prefer} onChange={e=>setForm(f=>({...f,prefer:e.target.checked}))}/>
                Prefer
              </label>
              <button onClick={()=>addServer.mutate()} disabled={addServer.isPending}
                className="btn-primary text-sm mb-0.5">
                {addServer.isPending ? 'Adding…' : 'Add'}
              </button>
              <button onClick={()=>setShowAdd(false)} className="btn-secondary text-sm mb-0.5">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Results table */}
      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>
                {['Server','Reachable','Stratum','Offset','Delay','Jitter','Reference','Poll','Last Checked',''].map(h=>(
                  <th key={h} className="px-3 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {servers.map(srv => {
                const r = results.find(x => x.server_id === srv.id);
                return (
                  <tr key={srv.id} className="hover:bg-slate-50">
                    <td className="px-3 py-3">
                      <div className="font-mono font-medium text-slate-800 text-xs">{srv.address}</div>
                      {srv.description && <div className="text-xs text-slate-400">{srv.description}</div>}
                      {srv.prefer && <span className="text-xs bg-purple-100 text-purple-700 px-1 rounded">prefer</span>}
                    </td>
                    <td className="px-3 py-3">
                      {r ? (
                        r.reachable
                          ? <span className="text-xs font-medium text-green-600">✓ Yes</span>
                          : <span className="text-xs font-medium text-red-500">✗ No</span>
                      ) : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-3"><StratumBadge stratum={r?.stratum}/></td>
                    <td className="px-3 py-3"><OffsetBar ms={r?.offset_ms}/></td>
                    <td className="px-3 py-3 text-xs font-mono text-slate-600">{r?.delay_ms != null ? `${r.delay_ms.toFixed(2)}ms` : '—'}</td>
                    <td className="px-3 py-3 text-xs font-mono text-slate-600">{r?.jitter_ms != null ? `${r.jitter_ms.toFixed(2)}ms` : '—'}</td>
                    <td className="px-3 py-3 text-xs font-mono text-slate-500">{r?.reference || '—'}</td>
                    <td className="px-3 py-3 text-xs text-slate-500">{r?.poll_interval ? `${r.poll_interval}s` : '—'}</td>
                    <td className="px-3 py-3 text-xs text-slate-400">{r?.checked_at ? new Date(r.checked_at).toLocaleTimeString() : '—'}</td>
                    <td className="px-3 py-3">
                      <button onClick={()=>delServer.mutate(srv.id)} className="text-xs text-red-500 hover:underline">Remove</button>
                    </td>
                  </tr>
                );
              })}
              {!servers.length && (
                <tr><td colSpan={10} className="text-center text-slate-400 py-8">
                  No NTP servers configured. Add your first server above.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 text-xs text-slate-400 text-right">
        Results auto-refresh every 60s. Polling runs server-side every 5 minutes.
      </div>
    </div>
  );
}
