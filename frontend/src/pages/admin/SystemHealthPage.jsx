import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../../lib/api';

const SERVICE_META = {
  postgres: { label: 'PostgreSQL', icon: '🐘', pinnedAt: 'docker-compose.yml' },
  redis:    { label: 'Redis',      icon: '🟥', pinnedAt: 'docker-compose.yml' },
  kea:      { label: 'Kea DHCP',   icon: '📡', pinnedAt: 'infrastructure/kea/Dockerfile' },
  dns:      { label: 'DNS Engine', icon: '🛡️', pinnedAt: 'dns-engine/Dockerfile' },
  nginx:    { label: 'nginx',      icon: '🌐', pinnedAt: 'frontend/Dockerfile' },
  api:      { label: 'ClassGuard API', icon: '⚙️', pinnedAt: 'backend/Dockerfile' },
};

function gaugeColor(pct) {
  if (pct == null) return 'bg-slate-200';
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-green-500';
}

function Gauge({ label, pct, detail }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-500">{label}</span>
        <span className="font-mono text-slate-700">{pct != null ? `${pct.toFixed(0)}%` : '—'}</span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${gaugeColor(pct)}`} style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
      </div>
      {detail && <div className="text-[10px] text-slate-400 mt-0.5">{detail}</div>}
    </div>
  );
}

function ResourceCard({ node }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-slate-800 text-sm">{node.node_id}</span>
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <StatusDot online={node.reachable} />
          <span className={node.reachable ? 'text-green-600' : 'text-red-600'}>
            {node.reachable ? 'Reachable' : 'Unreachable'}
          </span>
        </div>
      </div>
      {node.reachable ? (
        <div className="space-y-3">
          <Gauge label="CPU load" pct={node.cpu_load_pct} detail={node.cpu_count ? `${node.cpu_count} cores` : null} />
          <Gauge label="Memory" pct={node.mem_used_pct} />
          <Gauge label="Disk" pct={node.disk_used_pct} detail={node.disk_total_gb ? `${node.disk_total_gb} GB total` : null} />
        </div>
      ) : (
        <div className="text-xs text-slate-400">No response from this node.</div>
      )}
    </div>
  );
}

function StatusDot({ online }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${online ? 'bg-green-500' : 'bg-red-500'}`} />
  );
}

function ServiceCard({ name, data }) {
  const meta = SERVICE_META[name] || { label: name, icon: '❓' };
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{meta.icon}</span>
          <span className="font-semibold text-slate-800 text-sm">{meta.label}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <StatusDot online={data.online} />
          <span className={data.online ? 'text-green-600' : 'text-red-600'}>
            {data.online ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>
      {data.online ? (
        <div className="text-xs text-slate-500 space-y-0.5">
          {data.version && <div className="font-mono text-slate-700">{data.version}</div>}
          {data.detail && <div>{data.detail}</div>}
        </div>
      ) : (
        <div className="text-xs text-red-500 font-mono break-all">{data.error || 'No response'}</div>
      )}
      <div className="text-[10px] text-slate-300 mt-2 pt-2 border-t border-slate-100">
        Version pinned in <span className="font-mono">{meta.pinnedAt}</span>
      </div>
    </div>
  );
}

export default function SystemHealthPage() {
  const { data, isLoading, dataUpdatedAt, refetch, isFetching } = useQuery({
    queryKey: ['system-health'],
    queryFn:  () => api.get('/system/health'),
    refetchInterval: 30_000,
  });

  const { data: integrations } = useQuery({
    queryKey: ['integrations-status-summary'],
    queryFn:  () => api.get('/integrations/status'),
  });

  const { data: resources } = useQuery({
    queryKey: ['system-resources'],
    queryFn:  () => api.get('/system/resources'),
    refetchInterval: 30_000,
  });

  const services = data ? Object.entries(data) : [];
  const offlineCount = services.filter(([, d]) => !d.online).length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">System Health</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Live status and version for every service ClassGuard depends on. Versions are pinned exactly
            in the repo, so an update only ever happens when someone deliberately changes one of these files —
            this page tells you what's actually running right now.
          </p>
        </div>
        <button
          className="btn-secondary text-sm flex-shrink-0"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {!isLoading && offlineCount > 0 && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-5">
          {offlineCount} service{offlineCount > 1 ? 's' : ''} not responding — see below.
        </div>
      )}

      {isLoading ? (
        <div className="text-slate-400 text-sm">Checking services…</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map(([name, d]) => <ServiceCard key={name} name={name} data={d} />)}
        </div>
      )}

      {dataUpdatedAt > 0 && (
        <p className="text-xs text-slate-400 mt-3">
          Last checked {new Date(dataUpdatedAt).toLocaleTimeString()} · auto-refreshes every 30s
        </p>
      )}

      {/* Server resource usage — CPU/memory/disk for this node and every
          other known cluster node, so you can tell if you're close to or
          exceeding capacity rather than just whether services are up.
          Same data Zabbix can poll via /metrics (Settings > Monitoring). */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Server Resources</h2>
        {!resources ? (
          <div className="text-slate-400 text-sm">Loading…</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {resources.map(n => <ResourceCard key={n.node_id} node={n} />)}
          </div>
        )}
      </div>

      {/* External integrations — different risk (vendor API changes, not a
          version we control), already tracked on the Integrations page. */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-700">External Integrations</h2>
          <Link to="/admin/integrations" className="text-xs text-primary-600 hover:underline">
            Full integrations page →
          </Link>
        </div>
        {!integrations ? (
          <div className="text-slate-400 text-sm">Loading…</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.entries(integrations).map(([name, d]) => (
              <div key={name} className="card p-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-slate-800 text-sm capitalize">{name}</span>
                  {d.configured ? (
                    d.lastError
                      ? <span className="text-xs font-medium text-red-600">Error</span>
                      : <span className="text-xs font-medium text-green-600">OK</span>
                  ) : (
                    <span className="text-xs font-medium text-slate-400">Not configured</span>
                  )}
                </div>
                {d.configured && (
                  <div className="text-xs text-slate-500 space-y-0.5">
                    <div>Last sync: {d.lastSync ? new Date(d.lastSync).toLocaleString() : 'never'}</div>
                    {d.lastError && <div className="text-red-500 break-all">{d.lastError}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
