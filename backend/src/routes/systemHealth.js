// System Health — live status + version for every self-hosted service
// ClassGuard depends on (Kea, Postgres, Redis, nginx, the DNS engine, and
// this API itself). Distinct from /api/v1/integrations/status, which covers
// external API integrations (UniFi, Mosyle, Google, Snipe-IT) — those are a
// different kind of risk (the vendor changes their API, not something we
// control by pinning a version) and already have their own status surface.
const { Router } = require('express');
const axios = require('axios');
const os = require('os');
const { pool } = require('../db');
const redis = require('../redis');
const { keaCommand } = require('../services/kea');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getResourceUsage } = require('../services/systemResources');

const router = Router();
const auth = [authenticate, requirePermission('system_health')];

async function checkPostgres() {
  const { rows } = await pool.query('SELECT version()');
  const { rows: ext } = await pool.query(
    `SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`
  );
  const match = /PostgreSQL (\S+)/.exec(rows[0].version);
  return {
    online:  true,
    version: match ? match[1] : rows[0].version,
    detail:  ext[0] ? `TimescaleDB ${ext[0].extversion}` : null,
  };
}

async function checkRedis() {
  const info = await redis.info('server');
  const get = key => (new RegExp(`${key}:(.+)`).exec(info) || [])[1]?.trim();
  return {
    online:  true,
    version: get('redis_version'),
    detail:  `uptime ${Math.floor((parseInt(get('uptime_in_seconds'), 10) || 0) / 3600)}h`,
  };
}

async function checkKea() {
  const [ver, status] = await Promise.all([
    keaCommand('version-get', 'dhcp4'),
    keaCommand('status-get', 'dhcp4'),
  ]);
  const uptimeSec = status.arguments?.uptime || 0;
  return {
    online:  true,
    version: ver.text,
    detail:  `uptime ${Math.floor(uptimeSec / 3600)}h`,
  };
}

async function checkDnsEngine() {
  const res = await axios.get('http://dns:3053/health', { timeout: 5000 });
  return {
    online:  res.data.status === 'ok',
    version: null,
    detail:  `${res.data.blocklist?.toLocaleString?.() ?? res.data.blocklist} blocklist entries loaded`,
  };
}

async function checkNginx() {
  const res = await axios.head('http://frontend:80/', { timeout: 5000, validateStatus: () => true });
  const server = res.headers['server'] || '';
  const match = /nginx\/(\S+)/.exec(server);
  return { online: true, version: match ? match[1] : server || null, detail: null };
}

function checkApi() {
  const { version } = require('../config');
  return {
    online:  true,
    version: `ClassGuard ${version} / Node ${process.version}`,
    detail:  `uptime ${Math.floor(process.uptime() / 3600)}h`,
  };
}

// Resource usage (CPU load, memory, disk) for this node plus every other
// known cluster node -- reuses /metrics (already token-gated) as the data
// source for OTHER nodes. Deliberately NOT using INTERNAL_SECRET here: that
// value is generated independently per node at install time and never
// synced (see ha.js's vrrp-local comment) -- it only ever proves "this is
// trusted local infra", never "this is another cluster member". The
// zabbix_metrics_token, by contrast, lives in the `settings` table, which
// already replicates HA-wide via Postgres -- the same row is visible on
// every node with zero extra sync code. Auto-generated here if missing so
// the cluster resource view works without requiring Zabbix to be set up
// first (it also conveniently pre-fills the field under Settings >
// Monitoring for whenever Zabbix is configured).
async function getOrCreateMetricsToken() {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'zabbix_metrics_token'`);
  if (rows[0]?.value) return rows[0].value;
  const token = require('crypto').randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('zabbix_metrics_token', $1, NOW())
     ON CONFLICT (key) DO NOTHING`,
    [token]
  );
  const { rows: after } = await pool.query(`SELECT value FROM settings WHERE key = 'zabbix_metrics_token'`);
  return after[0]?.value || token;
}

async function getClusterResources() {
  const nodeId = process.env.NODE_ID || os.hostname();
  const local  = { node_id: nodeId, hostname: os.hostname(), reachable: true, ...getResourceUsage() };

  const [{ rows: nodes }, token] = await Promise.all([
    pool.query('SELECT node_id, hostname, api_url FROM nodes WHERE node_id <> $1', [nodeId]).catch(() => ({ rows: [] })),
    getOrCreateMetricsToken().catch(() => null),
  ]);

  const others = await Promise.all(nodes.map(async (n) => {
    if (!n.api_url || !token) return { node_id: n.node_id, hostname: n.hostname, reachable: false };
    try {
      const r = await axios.get(`${n.api_url}/metrics`, {
        headers: { 'X-Metrics-Token': token }, timeout: 3000,
      });
      return {
        node_id: n.node_id, hostname: n.hostname, reachable: true,
        cpu_count:       r.data.os_cpu_count,
        cpu_load_avg_1m: r.data.os_load_avg_1m,
        cpu_load_pct:    r.data.os_cpu_load_pct,
        mem_used_pct:    r.data.os_mem_used_pct,
        disk_total_gb:   r.data.os_disk_total_gb,
        disk_used_pct:   r.data.os_disk_used_pct,
      };
    } catch {
      return { node_id: n.node_id, hostname: n.hostname, reachable: false };
    }
  }));

  return [local, ...others];
}

router.get('/resources', ...auth, async (req, res) => {
  try {
    res.json(await getClusterResources());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', ...auth, async (req, res) => {
  const checks = {
    postgres:  checkPostgres,
    redis:     checkRedis,
    kea:       checkKea,
    dns:       checkDnsEngine,
    nginx:     checkNginx,
    api:       checkApi,
  };

  const results = {};
  await Promise.all(
    Object.entries(checks).map(async ([name, fn]) => {
      try {
        results[name] = await fn();
      } catch (err) {
        results[name] = { online: false, version: null, detail: null, error: err.message };
      }
    })
  );

  res.json(results);
});

module.exports = router;
