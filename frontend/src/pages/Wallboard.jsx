// Full-screen operations wallboard — cluster RADIUS/DNS load and per-node
// hardware, designed for a TV. Deliberately dark-only and self-styled (no
// Layout chrome, no theme dependence): a wall monitor never toggles themes.
//
// Two ways in: a logged-in admin opens /wallboard (JWT), or a kiosk browser
// opens /wallboard?token=<metrics token> so the TV never needs a login
// session. ?rotate=1 (or the Rotate button) cycles Network → DNS → Servers
// panels every 20s; default shows everything at once.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

// Palette validated for the dark surface (dataviz reference palette):
// categorical slots in fixed order for node identity; accepts/rejects use
// the blue/red diverging poles; status colors are reserved for state.
const NODE_COLORS = ['#3987e5', '#008300', '#d55181', '#c98500'];
const C = {
  page: '#0d0d0d', surface: '#1a1a19', ink: '#ffffff', ink2: '#c3c2b7',
  muted: '#898781', grid: '#2c2c2a', border: 'rgba(255,255,255,0.10)',
  accepts: '#3987e5', rejects: '#e66767', queries: '#3987e5', blocked: '#d95926',
  good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b',
};

const ROTATION = ['network', 'dns', 'servers'];
const ROTATE_MS = 20_000;

function wallboardGet(path, token) {
  const jwt = localStorage.getItem('cg_token');
  const sep = path.includes('?') ? '&' : '?';
  const url = token ? `${path}${sep}token=${encodeURIComponent(token)}` : path;
  return fetch(url, {
    headers: !token && jwt ? { Authorization: `Bearer ${jwt}` } : {},
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function usageStatus(pct) {
  if (pct == null) return null;
  if (pct >= 90) return 'critical';
  if (pct >= 80) return 'serious';
  return null; // normal usage carries no status color
}

function timeTick(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const TOOLTIP_STYLE = {
  contentStyle: {
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
    color: C.ink, fontSize: 13,
  },
  labelStyle: { color: C.ink2 },
  labelFormatter: t => new Date(t).toLocaleTimeString(),
};

function Tile({ label, value, unit, status, icon }) {
  const accent = status ? C[status] : null;
  return (
    <div className="wb-tile" style={accent ? { borderColor: accent } : undefined}>
      <div className="wb-tile-label">{label}</div>
      <div className="wb-tile-value">
        {value ?? '—'}{unit && <span className="wb-tile-unit">{unit}</span>}
      </div>
      {accent && <div className="wb-tile-status" style={{ color: accent }}>{icon} {status}</div>}
    </div>
  );
}

function ChartCard({ title, children, tall }) {
  return (
    <div className="wb-chart" style={tall ? { minHeight: 320 } : undefined}>
      <div className="wb-chart-title">{title}</div>
      <div className="wb-chart-body">{children}</div>
    </div>
  );
}

function UsageBar({ label, pct, detail }) {
  const status = usageStatus(pct);
  const barColor = status ? C[status] : C.accepts;
  return (
    <div className="wb-bar-row">
      <span className="wb-bar-label">{label}</span>
      <div className="wb-bar-track">
        <div className="wb-bar-fill" style={{ width: `${Math.min(pct ?? 0, 100)}%`, background: barColor }} />
      </div>
      <span className="wb-bar-pct">{pct == null ? '—' : `${Math.round(pct)}%`}</span>
      <span className="wb-bar-detail">{detail}</span>
    </div>
  );
}

function NodeCard({ node, color }) {
  const m = node.metrics || {};
  const vrrp = m.vrrp_state || (node.reachable ? '—' : 'OFFLINE');
  const vrrpColor = !node.reachable ? C.critical
    : vrrp === 'MASTER' ? C.good
    : vrrp === 'BACKUP' ? C.accepts
    : C.critical;
  const memUsedGb = m.os_mem_total_mb ? ((m.os_mem_total_mb - m.os_mem_free_mb) / 1024).toFixed(1) : null;
  const memTotalGb = m.os_mem_total_mb ? (m.os_mem_total_mb / 1024).toFixed(0) : null;
  const diskUsedGb = m.os_disk_total_gb ? (m.os_disk_total_gb * m.os_disk_used_pct / 100).toFixed(0) : null;
  return (
    <div className="wb-node" style={{ borderTopColor: color }}>
      <div className="wb-node-head">
        <span className="wb-node-name"><span className="wb-node-dot" style={{ background: color }} />{node.node_id}</span>
        <span className="wb-chip" style={{ color: vrrpColor, borderColor: vrrpColor }}>
          {node.reachable ? vrrp : '⚠ OFFLINE'}
        </span>
      </div>
      {node.reachable ? (
        <>
          <UsageBar label="CPU" pct={m.os_cpu_load_pct}
            detail={`load ${m.os_load_avg_1m ?? '—'} / ${m.os_cpu_count ?? '—'} cores`} />
          <UsageBar label="MEM" pct={m.os_mem_used_pct}
            detail={memUsedGb ? `${memUsedGb} of ${memTotalGb} GB` : ''} />
          <UsageBar label="DISK" pct={m.os_disk_used_pct}
            detail={diskUsedGb ? `${diskUsedGb} of ${Math.round(m.os_disk_total_gb)} GB` : ''} />
          <div className="wb-node-foot">
            <span>v{m.app_version}</span>
            <span>{m.ha_role}</span>
            <span>API up {fmtUptime(m.uptime_seconds)}</span>
          </div>
        </>
      ) : (
        <div className="wb-node-offline">Node unreachable{node.error ? ` — ${node.error}` : ''}</div>
      )}
    </div>
  );
}

export default function Wallboard() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [rotating, setRotating] = useState(params.get('rotate') != null);
  const [viewIdx, setViewIdx] = useState(0);
  const [now, setNow] = useState(() => new Date());

  // A logged-in admin without a kiosk token must have a session.
  useEffect(() => {
    if (!token && !localStorage.getItem('cg_token')) window.location.replace('/login');
  }, [token]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!rotating) return undefined;
    const t = setInterval(() => setViewIdx(i => (i + 1) % ROTATION.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [rotating]);

  const { data: cluster, error: clusterError } = useQuery({
    queryKey: ['wb-cluster', token],
    queryFn: () => wallboardGet('/metrics/cluster', token),
    refetchInterval: 10_000,
  });
  const { data: history } = useQuery({
    queryKey: ['wb-history', token],
    queryFn: () => wallboardGet('/metrics/history?minutes=180', token),
    refetchInterval: 60_000,
  });

  const nodes = useMemo(
    () => [...(cluster?.nodes || [])].sort((a, b) => a.node_id.localeCompare(b.node_id)),
    [cluster]);
  const nodeColor = Object.fromEntries(nodes.map((n, i) => [n.node_id, NODE_COLORS[i % NODE_COLORS.length]]));
  const primary = nodes.find(n => n.metrics?.ha_role === 'primary') || nodes[0];
  const pm = primary?.metrics || {};

  // Cluster-wide series (RADIUS/DNS come from replicated tables, so every
  // node reports the same numbers) — read them from the primary's history.
  const clusterSeries = useMemo(() => {
    const h = history?.nodes || {};
    return h[primary?.node_id] || Object.values(h)[0] || [];
  }, [history, primary]);

  // Per-node hardware series merged on timestamp for the multi-line charts.
  const hwSeries = useMemo(() => {
    const h = history?.nodes || {};
    const byT = new Map();
    for (const [nodeId, points] of Object.entries(h)) {
      for (const p of points) {
        const row = byT.get(p.t) || { t: p.t };
        row[`cpu_${nodeId}`] = p.os_cpu_load_pct;
        row[`mem_${nodeId}`] = p.os_mem_used_pct;
        byT.set(p.t, row);
      }
    }
    return [...byT.values()].sort((a, b) => new Date(a.t) - new Date(b.t));
  }, [history]);

  const nodesOnline = nodes.filter(n => n.reachable).length;
  const view = rotating ? ROTATION[viewIdx] : 'all';
  const show = section => view === 'all' || view === section;

  const certDays = pm.tls_cert_days_remaining;
  const certStatus = certDays == null ? null : certDays < 14 ? 'critical' : certDays < 30 ? 'warning' : null;

  return (
    <div className="wb-root">
      <style>{WALLBOARD_CSS}</style>
      <header className="wb-header">
        <div className="wb-brand">
          ClassGuard <span className="wb-brand-sub">Network Operations</span>
        </div>
        <div className="wb-header-mid">
          {nodes.map(n => (
            <span key={n.node_id} className="wb-chip"
              style={{ color: n.reachable ? C.ink2 : C.critical, borderColor: C.border }}>
              <span className="wb-node-dot" style={{ background: nodeColor[n.node_id] }} />
              {n.node_id} · {n.reachable ? (n.metrics?.vrrp_state || 'up') : '⚠ down'}
            </span>
          ))}
        </div>
        <div className="wb-header-right">
          <button className="wb-btn" onClick={() => setRotating(r => !r)}>
            {rotating ? `◼ ${view}` : '▶ rotate'}
          </button>
          <span className="wb-clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </header>

      {clusterError && (
        <div className="wb-error">
          Cannot reach ClassGuard metrics ({String(clusterError.message)}) — check the kiosk token or the network.
        </div>
      )}

      {show('network') && (
        <>
          <section className="wb-tiles">
            <Tile label="Active Sessions" value={pm.radius_sessions_active} />
            <Tile label="Accepts (5m)" value={pm.radius_auth_accepts_5m} />
            <Tile label="Rejects (5m)" value={pm.radius_auth_rejects_5m}
              status={pm.radius_auth_rejects_5m > 20 ? 'critical' : null} icon="⚠" />
            <Tile label="Pending Devices" value={pm.radius_devices_pending}
              status={pm.radius_devices_pending > 0 ? 'warning' : null} icon="●" />
            <Tile label="NAS Online" value={pm.radius_nas_active} />
            <Tile label="EAP Cert" value={certDays != null ? Math.floor(certDays) : null} unit="days"
              status={certStatus} icon="⚠" />
          </section>
          <section className="wb-grid-2">
            <ChartCard title="RADIUS authentications (5-min window)" tall={view === 'network'}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={clusterSeries}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={timeTick} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} minTickGap={40} />
                  <YAxis allowDecimals={false} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} width={36} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ color: C.ink2 }} />
                  <Area name="Accepts" dataKey="radius_auth_accepts_5m" stroke={C.accepts} fill={C.accepts} fillOpacity={0.25} strokeWidth={2} />
                  <Area name="Rejects" dataKey="radius_auth_rejects_5m" stroke={C.rejects} fill={C.rejects} fillOpacity={0.25} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Active RADIUS sessions" tall={view === 'network'}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={clusterSeries}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={timeTick} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} minTickGap={40} />
                  <YAxis allowDecimals={false} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} width={36} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Area name="Sessions" dataKey="radius_sessions_active" stroke={C.accepts} fill={C.accepts} fillOpacity={0.25} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
          </section>
        </>
      )}

      {show('dns') && (
        <>
          <section className="wb-tiles">
            <Tile label="DNS Queries/s" value={pm.dns_queries_per_second} />
            <Tile label="Queries (24h)" value={pm.dns_queries_24h?.toLocaleString?.() ?? pm.dns_queries_24h} />
            <Tile label="Blocked (24h)" value={pm.dns_blocked_24h?.toLocaleString?.() ?? pm.dns_blocked_24h} />
            <Tile label="Block Rate" value={pm.dns_block_rate_pct} unit="%" />
            <Tile label="Active Students" value={pm.active_students} />
            <Tile label="Nodes Online" value={cluster ? `${nodesOnline}/${nodes.length}` : null}
              status={cluster && nodesOnline < nodes.length ? 'critical' : null} icon="⚠" />
          </section>
          {/* Combined view: DNS chart full-width (the servers section already
              graphs CPU); zoomed DNS view pairs it with CPU for context. */}
          <section className={view === 'dns' ? 'wb-grid-2' : 'wb-grid-1'}>
            <ChartCard title="DNS queries vs blocked (per minute)" tall={view === 'dns'}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={clusterSeries}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={timeTick} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} minTickGap={40} />
                  <YAxis allowDecimals={false} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} width={36} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ color: C.ink2 }} />
                  <Area name="Queries" dataKey="dns_queries_last_60s" stroke={C.queries} fill={C.queries} fillOpacity={0.25} strokeWidth={2} />
                  <Area name="Blocked" dataKey="dns_blocked_last_60s" stroke={C.blocked} fill={C.blocked} fillOpacity={0.25} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
            {view === 'dns' && (
            <ChartCard title="CPU load % by node" tall>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={hwSeries}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={timeTick} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} minTickGap={40} />
                  <YAxis domain={[0, 100]} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} width={36} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ color: C.ink2 }} />
                  {nodes.map(n => (
                    <Line key={n.node_id} name={n.node_id} dataKey={`cpu_${n.node_id}`}
                      stroke={nodeColor[n.node_id]} strokeWidth={2} dot={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
            )}
          </section>
        </>
      )}

      {show('servers') && (
        <>
          <section className="wb-nodes">
            {nodes.map(n => <NodeCard key={n.node_id} node={n} color={nodeColor[n.node_id]} />)}
          </section>
          <section className="wb-grid-2">
            <ChartCard title="Memory used % by node" tall={view === 'servers'}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={hwSeries}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={timeTick} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} minTickGap={40} />
                  <YAxis domain={[0, 100]} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} width={36} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ color: C.ink2 }} />
                  {nodes.map(n => (
                    <Line key={n.node_id} name={n.node_id} dataKey={`mem_${n.node_id}`}
                      stroke={nodeColor[n.node_id]} strokeWidth={2} dot={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="CPU load % by node" tall={view === 'servers'}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={hwSeries}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={timeTick} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} minTickGap={40} />
                  <YAxis domain={[0, 100]} stroke={C.muted} tick={{ fill: C.muted, fontSize: 12 }} width={36} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ color: C.ink2 }} />
                  {nodes.map(n => (
                    <Line key={n.node_id} name={n.node_id} dataKey={`cpu_${n.node_id}`}
                      stroke={nodeColor[n.node_id]} strokeWidth={2} dot={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </section>
        </>
      )}
    </div>
  );
}

const WALLBOARD_CSS = `
.wb-root {
  min-height: 100vh; background: ${C.page}; color: ${C.ink};
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 16px 20px; display: flex; flex-direction: column; gap: 14px;
}
.wb-header { display: flex; align-items: center; gap: 16px; }
.wb-brand { font-size: 22px; font-weight: 700; white-space: nowrap; }
.wb-brand-sub { font-weight: 400; color: ${C.muted}; font-size: 15px; margin-left: 6px; }
.wb-header-mid { display: flex; gap: 10px; flex: 1; flex-wrap: wrap; }
.wb-header-right { display: flex; align-items: center; gap: 12px; }
.wb-clock { font-size: 26px; font-weight: 600; }
.wb-btn {
  background: none; border: 1px solid ${C.border}; color: ${C.ink2};
  border-radius: 8px; padding: 4px 12px; font-size: 13px; cursor: pointer;
}
.wb-btn:hover { color: ${C.ink}; }
.wb-chip {
  display: inline-flex; align-items: center; gap: 6px; border: 1px solid;
  border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 600;
}
.wb-node-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.wb-error {
  background: ${C.surface}; border: 1px solid ${C.critical}; color: ${C.critical};
  border-radius: 10px; padding: 10px 14px; font-size: 14px;
}
.wb-tiles { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
.wb-tile {
  background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 12px;
  padding: 12px 16px; display: flex; flex-direction: column; gap: 2px;
}
.wb-tile-label { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: ${C.muted}; }
.wb-tile-value { font-size: 34px; font-weight: 700; line-height: 1.15; }
.wb-tile-unit { font-size: 15px; font-weight: 400; color: ${C.ink2}; margin-left: 4px; }
.wb-tile-status { font-size: 12px; font-weight: 700; text-transform: uppercase; }
.wb-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; flex: 1; }
.wb-grid-1 { display: grid; grid-template-columns: 1fr; gap: 12px; }
.wb-chart {
  background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 12px;
  padding: 12px 14px 6px; display: flex; flex-direction: column; min-height: 240px;
}
.wb-chart-title { font-size: 14px; font-weight: 600; color: ${C.ink2}; margin-bottom: 4px; }
.wb-chart-body { flex: 1; min-height: 0; }
.wb-nodes { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
.wb-node {
  background: ${C.surface}; border: 1px solid ${C.border}; border-top: 3px solid;
  border-radius: 12px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px;
}
.wb-node-head { display: flex; justify-content: space-between; align-items: center; }
.wb-node-name { font-size: 17px; font-weight: 700; display: inline-flex; align-items: center; gap: 8px; }
.wb-node-foot { display: flex; gap: 16px; font-size: 12px; color: ${C.muted}; margin-top: 2px; }
.wb-node-offline { color: ${C.critical}; font-size: 14px; padding: 12px 0; }
.wb-bar-row { display: grid; grid-template-columns: 42px 1fr 44px minmax(90px, auto); gap: 10px; align-items: center; }
.wb-bar-label { font-size: 12px; font-weight: 600; color: ${C.muted}; }
.wb-bar-track { height: 10px; background: ${C.grid}; border-radius: 5px; overflow: hidden; }
.wb-bar-fill { height: 100%; border-radius: 5px; }
.wb-bar-pct { font-size: 13px; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
.wb-bar-detail { font-size: 12px; color: ${C.muted}; text-align: right; }
@media (max-width: 1100px) {
  .wb-tiles { grid-template-columns: repeat(3, 1fr); }
  .wb-grid-2 { grid-template-columns: 1fr; }
}
`;
