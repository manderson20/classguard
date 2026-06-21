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

// Editable comma-separated list — used for upstream pool servers and
// allowed client subnets, both of which are TEXT[] columns on the backend.
function ListEditor({ label, hint, values, onChange, placeholder }) {
  const [text, setText] = useState((values || []).join(', '));
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1">{label}</label>
      {hint && <p className="text-xs text-slate-400 mb-1">{hint}</p>}
      <input
        className={INPUT}
        value={text}
        placeholder={placeholder}
        onChange={e => setText(e.target.value)}
        onBlur={() => onChange(text.split(',').map(s => s.trim()).filter(Boolean))}
      />
    </div>
  );
}

function LastSeenBadge({ lastSeenAt }) {
  if (!lastSeenAt) return <span className="text-slate-400 text-xs">Listed, never synced</span>;
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  const color = ageMs < 10 * 60_000 ? 'green' : ageMs < 60 * 60_000 ? 'yellow' : 'red';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium bg-${color}-100 text-${color}-700`}>
      {new Date(lastSeenAt).toLocaleString()}
    </span>
  );
}

// Devices actually polling this node's chrony for time — fed by
// ntp-client-report.sh (in the bundle below) running `chronyc clients` via
// cron and reporting it back. Only populated once that script is actually
// installed on a node with chrony running; an empty table here usually just
// means the bundle hasn't been deployed yet, not that nothing is syncing.
function NtpClientsSection() {
  const { data: clients = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['ntp-clients'],
    queryFn:  () => api.get('/ntp/clients'),
    refetchInterval: 60_000,
  });

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-800">Devices Polling This Server</h2>
        <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary text-sm disabled:opacity-50">
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>
              {['Device','Node','NTP Packets','Dropped','Last Seen'].map(h => (
                <th key={h} className="px-3 py-2 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {clients.map(c => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="px-3 py-3">
                  <div className="font-mono font-medium text-slate-800 text-xs">{c.client_address}</div>
                  {c.device_name && <div className="text-xs text-slate-400">{c.device_name}</div>}
                </td>
                <td className="px-3 py-3 text-xs font-mono text-slate-500">{c.node_id}</td>
                <td className="px-3 py-3 text-xs font-mono text-slate-600">{c.ntp_packets}</td>
                <td className="px-3 py-3 text-xs font-mono text-slate-600">{c.ntp_dropped}</td>
                <td className="px-3 py-3"><LastSeenBadge lastSeenAt={c.last_seen_at} /></td>
              </tr>
            ))}
            {!isLoading && clients.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-400 py-8 text-sm">
                No devices reported yet. Install <span className="font-mono text-xs">ntp-client-report.sh</span> (from
                the config bundle below) via cron on each node once chrony is running.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400 mt-2">
        Auto-refreshes every 60s. chrony only ever exposes a live snapshot per client (cumulative
        packet count, time since last packet) — not a per-request log — so this mirrors that shape
        rather than a full query history like DNS Logs.
      </p>
    </div>
  );
}

function NtpServerSection() {
  const qc = useQueryClient();
  const [form, setForm] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [activeFile, setActiveFile] = useState(null);

  const { data: cfgData = {} } = useQuery({
    queryKey: ['ntp-server-config'],
    queryFn:  () => api.get('/ntp/server-config'),
  });

  const save = useMutation({
    mutationFn: () => api.put('/ntp/server-config', form || cfgData),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['ntp-server-config'] }),
  });

  const cfg = form || cfgData;
  const set = (k, v) => setForm(p => ({ ...(p || cfgData), [k]: v }));

  const loadBundle = async () => {
    setLoadingBundle(true);
    try {
      const b = await api.get('/ntp/server-bundle');
      setBundle(b);
      setActiveFile(Object.keys(b)[0]);
    } finally {
      setLoadingBundle(false);
    }
  };

  const downloadFile = (name, content) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    a.download = name;
    a.click();
  };

  return (
    <div className="mb-8">
      <h2 className="font-semibold text-slate-800 mb-3">NTP Server — Serve Time to the LAN</h2>

      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
        <p className="text-xs text-slate-500 mb-4">
          Runs <strong>chrony</strong> on every node, independently — unlike VRRP there's no
          failover priority here, every node just serves time on its own real IP. Point DHCP
          option 42 (or clients directly) at every node's IP for redundancy. Install chrony
          directly on the host (not in Docker) on each node and deploy the matching config below.
        </p>

        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer mb-4">
          <input type="checkbox" className="w-4 h-4 rounded"
            checked={cfg.enabled === true}
            onChange={e => set('enabled', e.target.checked)} />
          Enable NTP server config generation
        </label>

        <div className="grid md:grid-cols-2 gap-4">
          <ListEditor
            label="Upstream pool servers"
            hint="comma-separated — this node syncs its own clock from these"
            values={cfg.upstream_pool}
            placeholder="0.pool.ntp.org, 1.pool.ntp.org"
            onChange={v => set('upstream_pool', v)}
          />
          <ListEditor
            label="Allowed client subnets"
            hint="comma-separated CIDRs — required, or chrony serves no one (never defaults to allow-all)"
            values={cfg.allowed_subnets}
            placeholder="172.16.1.0/24, 10.0.0.0/16"
            onChange={v => set('allowed_subnets', v)}
          />
        </div>
        <div className="mt-4">
          <label className="text-xs font-medium text-slate-600 block mb-1">Local stratum fallback</label>
          <input type="number" className={INPUT + ' w-32'} value={cfg.local_stratum ?? 10}
            onChange={e => set('local_stratum', parseInt(e.target.value))} min={1} max={15} />
          <p className="text-xs text-slate-400 mt-1">Still serve LAN clients at this stratum if every upstream pool server is briefly unreachable.</p>
        </div>

        <div className="flex justify-end mt-4">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
            {save.isPending ? 'Saving…' : 'Save NTP Server Config'}
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-slate-900">chrony Config Files</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Generated from the settings above. Deploy to each node's host (outside Docker) —
              also includes <span className="font-mono">ntp-client-report.sh</span>, which feeds
              the "Devices Polling This Server" list below once installed via cron.
            </p>
          </div>
          <button onClick={loadBundle} disabled={loadingBundle} className="btn-primary text-sm">
            {loadingBundle ? 'Generating…' : 'Generate Configs'}
          </button>
        </div>

        {bundle && (
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="flex border-b border-slate-200 overflow-x-auto">
              {Object.keys(bundle).map(name => (
                <button key={name} onClick={() => setActiveFile(name)}
                  className={`px-3 py-2 text-xs font-mono whitespace-nowrap border-r border-slate-200 transition-colors
                    ${activeFile === name ? 'bg-primary-600 text-white' : 'hover:bg-slate-50 text-slate-600'}`}>
                  {name}
                </button>
              ))}
            </div>
            {activeFile && (
              <div className="relative">
                <div className="absolute top-2 right-2 flex gap-2">
                  <button onClick={() => navigator.clipboard.writeText(bundle[activeFile])}
                    className="bg-white border border-slate-200 rounded px-2 py-1 text-xs hover:bg-slate-50">Copy</button>
                  <button onClick={() => downloadFile(activeFile, bundle[activeFile])}
                    className="bg-white border border-slate-200 rounded px-2 py-1 text-xs hover:bg-slate-50">Download</button>
                </div>
                <pre className="p-4 text-xs font-mono bg-slate-900 text-slate-100 overflow-x-auto max-h-96 overflow-y-auto whitespace-pre">
                  {bundle[activeFile]}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function NtpPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ address:'', description:'', prefer: false });
  const [showAdd, setShowAdd] = useState(false);
  const [polling, setPolling] = useState(false);

  const { data: servers = [], isLoading } = useQuery({
    queryKey: ['ntp-servers'],
    queryFn:  () => api.get('/ntp/servers'),
    refetchInterval: 60_000,
  });

  const addServer = useMutation({
    mutationFn: () => api.post('/ntp/servers', form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ntp-servers'] });
      setShowAdd(false);
      setForm({ address:'', description:'', prefer: false });
    },
  });

  const delServer = useMutation({
    mutationFn: id => api.delete(`/ntp/servers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ntp-servers'] }),
  });

  const poll = async () => {
    setPolling(true);
    try { await api.post('/ntp/poll'); await qc.invalidateQueries({ queryKey: ['ntp-servers'] }); }
    finally { setPolling(false); }
  };

  const reachableServers = servers.filter(s => s.reachable && s.stratum != null);
  const synced   = reachableServers.length > 0;
  const minStrat = synced ? Math.min(...reachableServers.map(s => s.stratum)) : null;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <NtpServerSection />
      <NtpClientsSection />

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
              ? `Best stratum: ${minStrat ?? '—'} · ${servers.filter(s=>s.reachable).length} / ${servers.length} servers reachable`
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
              {servers.map(srv => (
                <tr key={srv.id} className="hover:bg-slate-50">
                  <td className="px-3 py-3">
                    <div className="font-mono font-medium text-slate-800 text-xs">{srv.address}</div>
                    {srv.description && <div className="text-xs text-slate-400">{srv.description}</div>}
                    {srv.prefer && <span className="text-xs bg-purple-100 text-purple-700 px-1 rounded">prefer</span>}
                  </td>
                  <td className="px-3 py-3">
                    {srv.checked_at ? (
                      srv.reachable
                        ? <span className="text-xs font-medium text-green-600">✓ Yes</span>
                        : <span className="text-xs font-medium text-red-500">✗ No</span>
                    ) : <span className="text-xs text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-3"><StratumBadge stratum={srv.stratum}/></td>
                  <td className="px-3 py-3"><OffsetBar ms={srv.offset_ms}/></td>
                  <td className="px-3 py-3 text-xs font-mono text-slate-600">{srv.delay_ms != null ? `${srv.delay_ms.toFixed(2)}ms` : '—'}</td>
                  <td className="px-3 py-3 text-xs font-mono text-slate-600">{srv.jitter_ms != null ? `${srv.jitter_ms.toFixed(2)}ms` : '—'}</td>
                  <td className="px-3 py-3 text-xs font-mono text-slate-500">{srv.reference || '—'}</td>
                  <td className="px-3 py-3 text-xs text-slate-500">{srv.poll_interval ? `${srv.poll_interval}s` : '—'}</td>
                  <td className="px-3 py-3 text-xs text-slate-400">{srv.checked_at ? new Date(srv.checked_at).toLocaleTimeString() : '—'}</td>
                  <td className="px-3 py-3">
                    <button onClick={()=>delServer.mutate(srv.id)} className="text-xs text-red-500 hover:underline">Remove</button>
                  </td>
                </tr>
              ))}
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
