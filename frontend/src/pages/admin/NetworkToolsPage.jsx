import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import api from '../../lib/api';

function OutputBlock({ text, placeholder }) {
  return (
    <pre className="bg-slate-900 text-slate-100 rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap min-h-[80px]">
      {text || placeholder}
    </pre>
  );
}

function PublicIpCard() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['network-tools-public-ip-all'],
    queryFn: () => api.get('/network-tools/public-ip/all'),
  });

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-900">Public IP Address (per node)</h2>
        <button className="btn-secondary text-xs" disabled={isFetching} onClick={() => refetch()}>
          {isFetching ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      <p className="text-xs text-slate-500 mb-3">
        What outbound traffic from each ClassGuard node actually shows up as on the public internet — useful for
        confirming what to allowlist on a vendor's end, or that failover didn't silently change the apparent source IP.
      </p>
      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="space-y-2">
          {(data || []).map(n => (
            <div key={n.node_id} className="flex items-center justify-between text-sm border border-slate-200 rounded-lg px-3 py-2">
              <span className="font-medium text-slate-700">{n.node_id}</span>
              {n.ip ? (
                <span className="font-mono text-slate-900">{n.ip}</span>
              ) : (
                <span className="text-red-600 text-xs">{n.error || 'unreachable'}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PingCard() {
  const [host, setHost] = useState('');
  const run = useMutation({
    mutationFn: () => api.post('/network-tools/ping', { host, count: 4 }),
  });

  return (
    <div className="card p-5">
      <h2 className="font-semibold text-slate-900 mb-3">Ping</h2>
      <div className="flex gap-2 mb-3">
        <input
          className="input text-sm flex-1"
          placeholder="hostname or IP, e.g. 8.8.8.8"
          value={host}
          onChange={e => setHost(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && host && run.mutate()}
        />
        <button className="btn-primary text-sm" disabled={!host || run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Pinging…' : 'Ping'}
        </button>
      </div>
      <OutputBlock
        text={run.data?.output || run.error?.message}
        placeholder="Output will appear here."
      />
    </div>
  );
}

function TracerouteCard() {
  const [host, setHost] = useState('');
  const run = useMutation({
    mutationFn: () => api.post('/network-tools/traceroute', { host }),
  });

  return (
    <div className="card p-5">
      <h2 className="font-semibold text-slate-900 mb-3">Traceroute</h2>
      <p className="text-xs text-slate-500 mb-3">Up to 20 hops, 1 probe per hop, 2s timeout — can take a few seconds.</p>
      <div className="flex gap-2 mb-3">
        <input
          className="input text-sm flex-1"
          placeholder="hostname or IP, e.g. google.com"
          value={host}
          onChange={e => setHost(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && host && run.mutate()}
        />
        <button className="btn-primary text-sm" disabled={!host || run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Tracing…' : 'Trace'}
        </button>
      </div>
      <OutputBlock
        text={run.data?.output || run.error?.message}
        placeholder="Output will appear here."
      />
    </div>
  );
}

export default function NetworkToolsPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Network Tools</h1>
        <p className="text-slate-500 text-sm mt-0.5">Ping, traceroute, and outbound public IP — run directly from the server, not your browser.</p>
      </div>

      <div className="space-y-6">
        <PublicIpCard />
        <PingCard />
        <TracerouteCard />
      </div>
    </div>
  );
}
