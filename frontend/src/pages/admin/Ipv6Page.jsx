import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const MONO  = 'font-mono text-xs';

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-b-0">
      <div className="min-w-0">
        <div className="text-xs text-slate-500">{label}</div>
        <div className={`${MONO} text-slate-800 truncate`}>{value || '—'}</div>
      </div>
      <button
        className="btn-secondary text-xs flex-shrink-0"
        onClick={() => { navigator.clipboard.writeText(value || ''); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        disabled={!value}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// The one step that can't be automated — UniFi's API here is read-only
// (confirmed against the existing integration), so an admin has to enter
// this themselves. ClassGuard is the IPv6 uplink only; UniFi stays the
// LAN's actual router for v6, same as it already is for v4.
function UnifiStaticRoutePanel({ cfg }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
      <h3 className="font-semibold text-slate-900 mb-1">UniFi Static Route Values</h3>
      <p className="text-xs text-slate-500 mb-4">
        UniFi's API has no way to push this — add it manually under your UniFi controller's
        Static Routes page. ClassGuard stays the IPv6 <em>uplink</em> only; UniFi keeps doing
        router advertisement/SLAAC for the LAN itself, exactly as it already does for IPv4.
      </p>
      <CopyField label="Destination" value={cfg.routed_prefix} />
      <CopyField label="Next-hop" value={cfg.local_ipv6} />
      <p className="text-xs text-slate-400 mt-3">
        Also worth setting in UniFi's IPv6 LAN settings: prefer DHCPv6 (Managed/M-flag) over
        pure SLAAC. IPv6 privacy addresses rotate periodically — DHCPv6 gives stable,
        trackable per-device leases instead, the same model as today's IPv4 DHCP.
      </p>
    </div>
  );
}

function StatusBadge({ status, lastSeenAt }) {
  if (!lastSeenAt) return <span className="text-slate-400 text-xs">Never reported</span>;
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  const stale = ageMs > 15 * 60_000;
  const color = status === 'up' && !stale ? 'green' : 'red';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium bg-${color}-100 text-${color}-700`}>
      {stale ? 'Stale' : status === 'up' ? 'Up' : 'Down'} · {new Date(lastSeenAt).toLocaleString()}
    </span>
  );
}

export default function Ipv6Page() {
  const qc = useQueryClient();
  const [form, setForm] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [activeFile, setActiveFile] = useState(null);

  const { data: cfgData = {} } = useQuery({
    queryKey: ['ipv6-config'],
    queryFn:  () => api.get('/ipv6/config'),
    refetchInterval: 60_000,
  });

  const save = useMutation({
    mutationFn: () => api.put('/ipv6/config', form || cfgData),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['ipv6-config'] }); setForm(null); },
  });

  const cfg = form || cfgData;
  const set = (k, v) => setForm(p => ({ ...(p || cfgData), [k]: v }));

  const loadBundle = async () => {
    setLoadingBundle(true);
    try {
      const b = await api.get('/ipv6/bundle');
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
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">IPv6 — Hurricane Electric Tunnel</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          For districts whose ISP doesn't offer native IPv6 (a district that does have native
          IPv6 simply leaves this disabled). ClassGuard terminates the tunnel as the IPv6
          uplink only — it does not become the LAN's router; that stays UniFi's job, same as
          it already is for IPv4. DNS-level filtering already sinkholes AAAA queries for
          blocked domains the same way it does A queries, independent of whether this is
          enabled at all.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
        <h3 className="font-semibold text-slate-900 mb-3">Hurricane Electric Tunnel Config</h3>

        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer mb-4">
          <input type="checkbox" className="w-4 h-4 rounded"
            checked={cfg.enabled === true}
            onChange={e => set('enabled', e.target.checked)} />
          Enable IPv6 tunnel config generation
        </label>

        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">HE Tunnel Server IPv4</label>
            <p className="text-xs text-slate-400 mb-1">From your tunnelbroker.net tunnel details page</p>
            <input className={INPUT} value={cfg.he_server_ipv4 || ''} placeholder="216.66.x.x"
              onChange={e => set('he_server_ipv4', e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">This host's public IPv4</label>
            <p className="text-xs text-slate-400 mb-1">The tunnel's local endpoint — must be static, no CGNAT in the way</p>
            <input className={INPUT} value={cfg.he_client_ipv4 || ''} placeholder="203.0.113.x"
              onChange={e => set('he_client_ipv4', e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Routed /64</label>
            <p className="text-xs text-slate-400 mb-1">The IPv6 block HE assigns — also entered in UniFi below</p>
            <input className={INPUT} value={cfg.routed_prefix || ''} placeholder="2001:db8::/64"
              onChange={e => set('routed_prefix', e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">This host's tunnel IPv6</label>
            <p className="text-xs text-slate-400 mb-1">From tunnelbroker.net — your "Client IPv6 Address"</p>
            <input className={INPUT} value={cfg.local_ipv6 || ''} placeholder="2001:db8::2"
              onChange={e => set('local_ipv6', e.target.value)} />
          </div>
        </div>

        <div className="flex justify-between items-center">
          <StatusBadge status={cfg.last_status} lastSeenAt={cfg.last_seen_at} />
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
            {save.isPending ? 'Saving…' : 'Save Tunnel Config'}
          </button>
        </div>
      </div>

      <UnifiStaticRoutePanel cfg={cfg} />

      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-slate-900">Tunnel Config Files</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Generated from the settings above. Deploy to the node terminating the tunnel's
              host (outside Docker) — same way chrony/keepalived are installed.
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
