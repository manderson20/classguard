/**
 * /metrics endpoint — Zabbix HTTP agent item format.
 *
 * This endpoint is per-node: nginx on every cluster member answers it
 * locally (default_server, all interfaces — not just the VIP), and each
 * node's own API container reports its own process/DNS/HA stats, including
 * its current VRRP role (vrrp_state / is_vrrp_master). Polling only the VIP
 * tells you "the service is up", but since the VIP always resolves to
 * whichever node currently holds MASTER, it can never show you a failover —
 * for that you need each node's real IP monitored as its own Zabbix host.
 * /metrics/zabbix-template generates exactly that: one host per cluster
 * member (pulled from the `nodes` table) plus one for the VIP, with a
 * trigger per node on vrrp_state changing and a cluster-wide split-brain
 * trigger if more than one node reports MASTER at once.
 *
 * Manual Zabbix configuration (if not using the generated template):
 *   Item type:  HTTP agent
 *   URL:        https://<node-ip-or-vip>/metrics
 *   Headers:    X-Metrics-Token: <token from Settings ▸ Monitoring>
 *   Output format: JSON
 *
 * Each metric key matches a Zabbix item key you create on the host.
 */

const express = require('express');
const router  = express.Router();
const { pool }  = require('../db');
const redis     = require('../redis');
const os        = require('os');
const { rateLimit } = require('express-rate-limit');
const { getHaConfig, getNodes } = require('../services/keepalived');
const kea = require('../services/kea');
const { getResourceUsage } = require('../services/systemResources');
const config = require('../config');

// Escape characters that are special in XML contexts
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Rate limiter for metrics endpoints — 300/min: Zabbix polls one request per
// metric key per cycle; 30+ keys + HA VIP host doubles some polls, so 60/min
// was too low and caused intermittent 429s on the generated template.
const metricsLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });

const DNS_STREAM = 'classguard:dns-log';

// ---------------------------------------------------------------------------
// Token auth middleware — metrics endpoint uses a simple shared secret
// so Zabbix doesn't need a JWT/session
// ---------------------------------------------------------------------------
async function metricsAuth(req, res, next) {
  const token = req.headers['x-metrics-token'] || req.query.token;

  // If no token configured, allow local requests only
  if (!token) {
    const ip = req.ip || req.connection.remoteAddress;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    return res.status(401).json({ error: 'X-Metrics-Token header required' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT value FROM settings WHERE key = 'zabbix_metrics_token'`
    );
    const stored = rows[0]?.value;
    if (!stored || token !== stored) return res.status(401).json({ error: 'Invalid token' });
    next();
  } catch {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

// ---------------------------------------------------------------------------
// Metrics collection
// ---------------------------------------------------------------------------

async function collectMetrics() {
  const memUsage   = process.memoryUsage();
  const loadAvg    = os.loadavg();
  const freemem    = os.freemem();
  const totalmem   = os.totalmem();
  const uptimeSec  = process.uptime();
  const resources  = getResourceUsage(); // adds disk usage, which os.* alone can't provide

  // DNS query counts from TimescaleDB (last 60s and last 24h)
  const { rows: dnsRows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE queried_at > NOW() - INTERVAL '60 seconds')   AS queries_last_60s,
      COUNT(*) FILTER (WHERE queried_at > NOW() - INTERVAL '60 seconds'
                         AND action = 'blocked')                            AS blocked_last_60s,
      COUNT(*) FILTER (WHERE queried_at > NOW() - INTERVAL '24 hours')     AS queries_24h,
      COUNT(*) FILTER (WHERE queried_at > NOW() - INTERVAL '24 hours'
                         AND action = 'blocked')                            AS blocked_24h
    FROM dns_logs
    WHERE queried_at > NOW() - INTERVAL '24 hours'
  `);
  const dns = dnsRows[0] || {};

  const q60   = parseInt(dns.queries_last_60s, 10) || 0;
  const b60   = parseInt(dns.blocked_last_60s, 10)  || 0;
  const q24h  = parseInt(dns.queries_24h, 10)       || 0;
  const b24h  = parseInt(dns.blocked_24h, 10)        || 0;

  // Active students (device registrations in Redis, last 5min)
  let activeStudents = 0;
  try {
    const keys = await redis.keys('device:*');
    activeStudents = keys.length;
  } catch { /* redis unavailable */ }

  // Redis stream backlog (unprocessed log entries)
  let streamLen = 0;
  try {
    streamLen = await redis.xlen(DNS_STREAM);
  } catch { /* ignore */ }

  // PostgreSQL connection pool stats
  const { rows: pgRows } = await pool.query(`
    SELECT
      count(*) AS total_connections,
      count(*) FILTER (WHERE state = 'active') AS active_connections,
      count(*) FILTER (WHERE state = 'idle')   AS idle_connections
    FROM pg_stat_activity
    WHERE datname = current_database()
  `).catch(() => ({ rows: [{}] }));
  const pg = pgRows[0] || {};

  // NTP sync status
  const { rows: ntpRows } = await pool.query(`
    SELECT MIN(stratum) AS min_stratum,
           COUNT(*) FILTER (WHERE reachable) AS reachable_count,
           COUNT(*) AS total_count
    FROM ntp_peer_status
    WHERE checked_at > NOW() - INTERVAL '10 minutes'
  `).catch(() => ({ rows: [{}] }));
  const ntp = ntpRows[0] || {};

  // DHCP pool utilization — aggregate across every configured subnet, via
  // the same Kea stat-lease4-get command the DHCP Management page already
  // uses per-subnet (routes/dhcp.js). Kea deliberately never runs on a
  // standby node (its DB is a read-only replica, leases can't be written
  // there), so a standby always reports dhcp_kea_reachable=0 — expected,
  // not an error; poll this metric from the primary/VIP, same as the DNS
  // throughput metrics above.
  let dhcpTotal = 0, dhcpUsed = 0, dhcpReachable = 0;
  try {
    const stats = await kea.getStats();
    for (const row of stats) {
      dhcpTotal += row['total-addresses'] || 0;
      dhcpUsed  += (row['assigned-addresses'] || 0) + (row['declined-addresses'] || 0);
    }
    dhcpReachable = 1;
  } catch { /* Kea offline or this is a standby node — leave zeros */ }
  const { rows: subnetRows } = await pool.query(
    `SELECT COUNT(*) AS total FROM dhcp_subnets`
  ).catch(() => ({ rows: [{}] }));

  // RADIUS — auth throughput from the (replicated, cluster-wide) auth log,
  // plus live session/device/NAS counts. Same values from every node.
  const { rows: radiusRows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM radius_auth_log
        WHERE logged_at > NOW() - INTERVAL '5 minutes' AND result = 'accepted') AS accepts_5m,
      (SELECT COUNT(*) FROM radius_auth_log
        WHERE logged_at > NOW() - INTERVAL '5 minutes' AND result = 'rejected') AS rejects_5m,
      (SELECT COUNT(*) FROM radius_sessions WHERE is_active)                    AS sessions_active,
      (SELECT COUNT(*) FROM radius_devices WHERE status = 'pending')            AS devices_pending,
      (SELECT COUNT(*) FROM radius_devices WHERE status = 'approved')           AS devices_approved,
      (SELECT COUNT(*) FROM radius_devices WHERE status = 'blocked')            AS devices_blocked,
      (SELECT COUNT(*) FROM radius_nas WHERE is_active)                         AS nas_active
  `).catch(() => ({ rows: [{}] }));
  const radius = radiusRows[0] || {};

  // Web/EAP certificate expiry (ACME cert from tls_config — the EAP cert is
  // this same cert when ACME is enabled, else a host-local self-signed one
  // that only the Zabbix agent's classguard.eap.cert.days item can see).
  const { rows: tlsRows } = await pool.query(
    `SELECT enabled, cert_expires_at FROM tls_config LIMIT 1`
  ).catch(() => ({ rows: [] }));
  const tls = tlsRows[0] || {};
  const certDays = tls.cert_expires_at
    ? parseFloat(((new Date(tls.cert_expires_at) - Date.now()) / 86_400_000).toFixed(1))
    : null;

  // Node count (HA)
  const { rows: nodeRows } = await pool.query(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '60 seconds') AS online
    FROM nodes
  `).catch(() => ({ rows: [{}] }));
  const nodes = nodeRows[0] || {};

  // This node's own VRRP role — distinct from the cluster-wide totals above.
  // Lets Zabbix poll each node's real IP (not just the VIP) and alert on a
  // role flip (failover happened) or two nodes both reporting MASTER
  // (split-brain), instead of only seeing "service is up" via the VIP.
  const nodeId = process.env.NODE_ID || os.hostname();
  const { rows: selfRows } = await pool.query(
    `SELECT ha_role, vrrp_state, failover_priority, db_lag_bytes FROM nodes WHERE node_id = $1`,
    [nodeId]
  ).catch(() => ({ rows: [] }));
  const self = selfRows[0] || null;
  // No row at all means this is a standalone, non-HA install — trivially
  // "master" since there's no failover peer to lose that status to.
  const vrrpState = self ? (self.vrrp_state || null) : null;

  return {
    // Identity
    node_id:   nodeId,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(uptimeSec),
    app_version: config.version,

    // DNS throughput
    dns_queries_per_second:  parseFloat((q60 / 60).toFixed(2)),
    dns_queries_last_60s:    q60,
    dns_blocked_last_60s:    b60,
    dns_block_rate_pct:      q60 > 0 ? parseFloat(((b60 / q60) * 100).toFixed(2)) : 0,
    dns_queries_24h:         q24h,
    dns_blocked_24h:         b24h,
    dns_log_stream_backlog:  streamLen,

    // Active sessions
    active_students:         activeStudents,

    // Node.js process
    nodejs_heap_used_mb:     parseFloat((memUsage.heapUsed / 1024 / 1024).toFixed(2)),
    nodejs_heap_total_mb:    parseFloat((memUsage.heapTotal / 1024 / 1024).toFixed(2)),
    nodejs_rss_mb:           parseFloat((memUsage.rss / 1024 / 1024).toFixed(2)),

    // OS / system
    os_load_avg_1m:          parseFloat(loadAvg[0].toFixed(2)),
    os_load_avg_5m:          parseFloat(loadAvg[1].toFixed(2)),
    os_load_avg_15m:         parseFloat(loadAvg[2].toFixed(2)),
    os_mem_free_mb:          Math.round(freemem / 1024 / 1024),
    os_mem_total_mb:         Math.round(totalmem / 1024 / 1024),
    os_mem_used_pct:         parseFloat((((totalmem - freemem) / totalmem) * 100).toFixed(2)),
    os_cpu_count:            os.cpus().length,
    os_cpu_load_pct:         resources.cpu_load_pct,
    os_disk_total_gb:        resources.disk_total_gb,
    os_disk_used_pct:        resources.disk_used_pct,

    // PostgreSQL
    pg_connections_total:    parseInt(pg.total_connections, 10)  || 0,
    pg_connections_active:   parseInt(pg.active_connections, 10) || 0,
    pg_connections_idle:     parseInt(pg.idle_connections, 10)   || 0,

    // DHCP pool utilization (aggregate across every configured subnet)
    dhcp_kea_reachable:      dhcpReachable,
    dhcp_subnets_configured: parseInt(subnetRows[0]?.total, 10) || 0,
    dhcp_pool_total_addresses: dhcpTotal,
    dhcp_pool_used_addresses:  dhcpUsed,
    dhcp_pool_free_addresses:  Math.max(0, dhcpTotal - dhcpUsed),
    dhcp_pool_utilization_pct: dhcpTotal > 0 ? parseFloat(((dhcpUsed / dhcpTotal) * 100).toFixed(2)) : 0,

    // RADIUS / NAC — auth log is replicated, so every node reports the
    // same cluster-wide numbers; alert on these from one host (VIP) only.
    radius_auth_accepts_5m:  parseInt(radius.accepts_5m, 10)      || 0,
    radius_auth_rejects_5m:  parseInt(radius.rejects_5m, 10)      || 0,
    radius_sessions_active:  parseInt(radius.sessions_active, 10) || 0,
    radius_devices_pending:  parseInt(radius.devices_pending, 10) || 0,
    radius_devices_approved: parseInt(radius.devices_approved, 10)|| 0,
    radius_devices_blocked:  parseInt(radius.devices_blocked, 10) || 0,
    radius_nas_active:       parseInt(radius.nas_active, 10)      || 0,

    // TLS certificate (ACME web cert; also the EAP cert when ACME is on)
    tls_cert_enabled:        tls.enabled ? 1 : 0,
    tls_cert_days_remaining: certDays,

    // NTP
    ntp_min_stratum:         ntp.min_stratum ? parseInt(ntp.min_stratum, 10) : null,
    ntp_reachable_servers:   parseInt(ntp.reachable_count, 10) || 0,
    ntp_total_servers:       parseInt(ntp.total_count, 10)     || 0,
    ntp_synced:              (parseInt(ntp.reachable_count, 10) || 0) > 0 ? 1 : 0,

    // HA cluster — totals across the whole cluster
    ha_nodes_total:          parseInt(nodes.total, 10)  || 1,
    ha_nodes_online:         parseInt(nodes.online, 10) || 1,

    // HA cluster — THIS node's own VRRP role. Poll this per-node (not just
    // via the VIP) to detect a failover or split-brain, not just "is the
    // service up". Standalone (non-HA) installs report ha_configured=false
    // and is_vrrp_master=1 (trivially the only node).
    ha_configured:           self ? 1 : 0,
    ha_role:                 self?.ha_role || null,
    failover_priority:       self?.failover_priority ?? null,
    vrrp_state:              vrrpState,
    is_vrrp_master:          self ? (vrrpState === 'MASTER' ? 1 : 0) : 1,
    // Streaming replication lag as reported by this node's last heartbeat —
    // null on the primary (nothing to lag behind) and on standalone installs.
    db_replication_lag_bytes: self?.db_lag_bytes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /metrics  — main JSON metrics blob
router.get('/', metricsLimiter, metricsAuth, async (req, res) => {
  try {
    const metrics = await collectMetrics();
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fields whose Zabbix value_type is fixed by what they semantically are,
// rather than sniffed from whatever value happens to come back right now —
// several of these (vrrp_state, ha_role, failover_priority) are legitimately
// null on a healthy install (e.g. standalone, or a fresh node before
// keepalived's first notify), and sniffing off a momentary null would emit
// the wrong value_type for what is normally a number or always a string.
// 0=float, 1=character, 3=unsigned, 4=text.
const KNOWN_VALUE_TYPES = {
  vrrp_state:        '4',
  ha_role:           '4',
  failover_priority: '3',
  is_vrrp_master:    '3',
  ha_configured:     '3',
  ntp_min_stratum:   '3',
  ntp_synced:        '3',
  dhcp_kea_reachable: '3',
  app_version:       '4',
  tls_cert_enabled:  '3',
  tls_cert_days_remaining:  '0', // float; null until a cert is issued
  db_replication_lag_bytes: '3', // null on the primary, a number on standbys
};

function zabbixValueType(key, value) {
  if (KNOWN_VALUE_TYPES[key]) return KNOWN_VALUE_TYPES[key];
  if (typeof value === 'string' || value === null) return '4';
  if (typeof value === 'number' && !Number.isInteger(value)) return '0';
  return '3';
}

function buildItemsXml(keys, metrics, url, token) {
  return keys.map(k => `
    <item>
      <name>ClassGuard: ${xmlEscape(k.replace(/_/g, ' '))}</name>
      <type>19</type><!-- HTTP agent -->
      <key>classguard.${xmlEscape(k)}</key>
      <url>${xmlEscape(url)}</url>
      <headers>
        <header><name>X-Metrics-Token</name><value>${xmlEscape(token)}</value></header>
      </headers>
      <posts/>
      <status_codes>200</status_codes>
      <json_output>1</json_output>
      <output_format>3</output_format>
      <preprocessing>
        <step>
          <type>12</type><!-- JSONPath -->
          <params>$.${xmlEscape(k)}</params>
        </step>
      </preprocessing>
      <value_type>${zabbixValueType(k, metrics[k])}</value_type>
      <delay>60</delay>
    </item>`).join('\n');
}

function hostXml(techName, displayName, itemsXml) {
  return `
    <host>
      <host>${xmlEscape(techName)}</host>
      <name>${xmlEscape(displayName)}</name>
      <items>${itemsXml}
      </items>
    </host>`;
}

// GET /metrics/zabbix-template  — download a Zabbix import XML covering
// every cluster member's own IP (so a failover/role-flip is visible per
// node, not just "the VIP answers") plus the VIP itself (the "is the
// service reachable at all" check). Falls back to a single host pointed at
// this box's own URL for a standalone, non-HA install.
router.get('/zabbix-template', metricsLimiter, metricsAuth, async (req, res) => {
  const metrics = await collectMetrics().catch(() => ({}));
  const keys    = Object.keys(metrics).filter(k => !['node_id','timestamp'].includes(k));
  const token   = req.headers['x-metrics-token'] || req.query.token || '';

  const [nodes, haCfg] = await Promise.all([
    getNodes().catch(() => []),
    getHaConfig().catch(() => ({})),
  ]);

  const targets = [];
  for (const n of nodes) {
    if (!n.api_url) continue;
    let hostname;
    try { hostname = new URL(n.api_url).hostname; } catch { continue; }
    const shortName = n.hostname || n.node_id;
    targets.push({
      techName:    `ClassGuard - ${shortName}`,
      displayName: `ClassGuard — ${shortName} (node)`,
      shortName,
      url:         `https://${hostname}/metrics`,
      isNode:      true,
    });
  }
  if (haCfg.vip_address) {
    targets.push({
      techName:    'ClassGuard - VIP',
      displayName: 'ClassGuard — VIP (active service)',
      url:         `https://${haCfg.vip_address}/metrics`,
      isNode:      false,
    });
  }
  if (targets.length === 0) {
    targets.push({
      techName:    'ClassGuard',
      displayName: 'ClassGuard Network Safety',
      url:         `${process.env.APP_URL || 'http://localhost:3001'}/metrics`,
      isNode:      false,
    });
  }

  const hostsXml = targets
    .map(t => hostXml(t.techName, t.displayName, buildItemsXml(keys, metrics, t.url, token)))
    .join('\n');

  // Triggers: per-node role-flip (failover happened) + a cluster-wide
  // split-brain check (more than one node reporting MASTER at once).
  // Exported at the top level since the split-brain expression spans
  // multiple hosts — Zabbix resolves host association from the
  // /Host/key references in each expression, not from nesting.
  const nodeTargets = targets.filter(t => t.isNode);
  const triggers = nodeTargets.map(t => `
    <trigger>
      <expression>change(/${t.techName}/classguard.is_vrrp_master)&lt;&gt;0</expression>
      <name>ClassGuard: ${t.shortName} VRRP role changed (failover event)</name>
      <priority>3</priority><!-- average -->
    </trigger>`);
  // Disk/CPU thresholds -- skipped if the metric came back null (df failed,
  // e.g. on a filesystem type df couldn't read) rather than emitting a
  // trigger that can never fire.
  if (metrics.os_disk_used_pct != null) {
    nodeTargets.forEach(t => triggers.push(`
    <trigger>
      <expression>last(/${t.techName}/classguard.os_disk_used_pct)&gt;90</expression>
      <name>ClassGuard: ${t.shortName} disk usage above 90%</name>
      <priority>4</priority><!-- high -->
    </trigger>`));
  }
  nodeTargets.forEach(t => triggers.push(`
    <trigger>
      <expression>min(/${t.techName}/classguard.os_cpu_load_pct,5m)&gt;90</expression>
      <name>ClassGuard: ${t.shortName} CPU load above 90% for 5+ minutes</name>
      <priority>3</priority><!-- average -->
    </trigger>`));
  if (nodeTargets.length >= 2) {
    const sumExpr = nodeTargets.map(t => `last(/${t.techName}/classguard.is_vrrp_master)`).join('+');
    triggers.push(`
    <trigger>
      <expression>(${sumExpr})&gt;1</expression>
      <name>ClassGuard: split-brain — more than one node reports MASTER</name>
      <priority>4</priority><!-- high -->
    </trigger>`);
    // Peer-offline check goes on every node: when one node dies, its own
    // trigger can't fire (no data) but each surviving node reports
    // ha_nodes_online < ha_nodes_total from the shared nodes table.
    nodeTargets.forEach(t => triggers.push(`
    <trigger>
      <expression>max(/${t.techName}/classguard.ha_nodes_online,5m)&lt;last(/${t.techName}/classguard.ha_nodes_total)</expression>
      <name>ClassGuard: ${t.shortName} reports a cluster peer offline</name>
      <priority>4</priority><!-- high -->
    </trigger>`));
  }
  // Cluster-wide values (replicated tables — every node reports the same
  // number): alert from a single host to avoid N duplicate alerts. Prefer
  // the VIP host since it always answers as long as the service is up.
  const clusterTarget = targets.find(t => !t.isNode) || targets[0];
  // Gate on an expiry existing, not on `enabled`: disabling ACME stops
  // renewal but nginx keeps serving the issued cert from disk (see
  // acmeTls.renewIfNeeded), which is exactly when expiry needs watching.
  if (metrics.tls_cert_days_remaining != null) {
    triggers.push(`
    <trigger>
      <expression>last(/${clusterTarget.techName}/classguard.tls_cert_days_remaining)&lt;14</expression>
      <name>ClassGuard: TLS/EAP certificate expires in under 14 days</name>
      <priority>4</priority><!-- high -->
    </trigger>`);
  }
  triggers.push(`
    <trigger>
      <expression>min(/${clusterTarget.techName}/classguard.radius_auth_rejects_5m,15m)&gt;20</expression>
      <name>ClassGuard: sustained RADIUS rejects (&gt;20 per 5m for 15m)</name>
      <priority>3</priority><!-- average -->
    </trigger>`);
  const triggersXml = triggers.length ? `\n  <triggers>${triggers.join('\n')}\n  </triggers>` : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<zabbix_export>
  <version>6.0</version>
  <hosts>${hostsXml}
  </hosts>${triggersXml}
</zabbix_export>`;

  res.set('Content-Type', 'application/xml');
  res.set('Content-Disposition', 'attachment; filename="classguard-zabbix-template.xml"');
  res.send(xml);
});

module.exports = router;
