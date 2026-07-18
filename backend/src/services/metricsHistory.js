// Cluster metrics sampling and history for the wallboard.
//
// Every node already exposes a point-in-time /metrics snapshot; the wallboard
// needs the same numbers across the whole cluster (live) and over time
// (graphs). The primary's scheduler calls sampleClusterMetrics() once a
// minute: it collects its own snapshot in-process, pulls each peer's over
// HTTP (X-Internal-Secret — same node-to-node trust as the /ha relays), and
// records one node_metrics_history row per reachable node. Sampling runs on
// the primary because a standby's replica is read-only; if the cluster is
// degraded with the VIP on a standby, history pauses rather than half-writes.

const config = require('../config');
const { query } = require('../db');
const { getNodes } = require('./keepalived');

const RETENTION_HOURS = 48;

// Keys the history endpoint returns — a fixed allowlist, interpolated into
// SQL below, so it must stay hardcoded identifiers only.
const HISTORY_KEYS = [
  'os_cpu_load_pct', 'os_mem_used_pct', 'os_disk_used_pct',
  'dns_queries_last_60s', 'dns_blocked_last_60s',
  'radius_auth_accepts_5m', 'radius_auth_rejects_5m', 'radius_sessions_active',
];

async function fetchPeerMetrics(node) {
  const res = await fetch(`${node.api_url}/metrics`, {
    headers: { 'X-Internal-Secret': process.env.INTERNAL_SECRET || '' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Live snapshot of every cluster member: local node in-process, peers over
// HTTP. Unreachable peers still get an entry (reachable: false) so the
// wallboard can show the node as down instead of silently dropping it.
async function clusterSnapshot() {
  // Required lazily: routes/metrics.js also requires this module at load.
  const { collectMetrics } = require('../routes/metrics');

  const results = [];
  const local = await collectMetrics().catch(() => null);
  if (local) results.push({ node_id: config.node.id, reachable: true, metrics: local });

  const nodes = await getNodes().catch(() => []);
  for (const n of nodes) {
    if (n.node_id === config.node.id || !n.api_url || n.is_active === false) continue;
    try {
      results.push({ node_id: n.node_id, reachable: true, metrics: await fetchPeerMetrics(n) });
    } catch (err) {
      results.push({ node_id: n.node_id, reachable: false, error: err.message });
    }
  }
  return results;
}

async function sampleClusterMetrics() {
  const snapshot = await clusterSnapshot();
  for (const s of snapshot) {
    if (!s.reachable) continue;
    await query(
      `INSERT INTO node_metrics_history (node_id, metrics)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [s.node_id, JSON.stringify(s.metrics)]
    );
  }
  await query(
    `DELETE FROM node_metrics_history
     WHERE sampled_at < NOW() - INTERVAL '${RETENTION_HOURS} hours'`
  );
}

// { "<node_id>": [ { t, <key>: number|null, ... } ] } ordered oldest-first.
async function getHistory(minutes) {
  const cols = HISTORY_KEYS.map(k => `metrics->>'${k}' AS ${k}`).join(', ');
  const { rows } = await query(
    `SELECT node_id, sampled_at, ${cols}
     FROM node_metrics_history
     WHERE sampled_at > NOW() - ($1 || ' minutes')::interval
     ORDER BY sampled_at`,
    [minutes]
  );
  const nodes = {};
  for (const r of rows) {
    (nodes[r.node_id] ||= []).push({
      t: r.sampled_at,
      ...Object.fromEntries(HISTORY_KEYS.map(k =>
        [k, r[k] == null ? null : Number(r[k])])),
    });
  }
  return nodes;
}

module.exports = { sampleClusterMetrics, clusterSnapshot, getHistory, HISTORY_KEYS };
