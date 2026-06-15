/**
 * /metrics endpoint — Zabbix HTTP agent item format.
 *
 * Zabbix configuration:
 *   Item type:  HTTP agent
 *   URL:        http://<classguard-ip>:3001/metrics
 *   Headers:    X-Metrics-Token: <token from settings>
 *   Output format: JSON
 *
 * Each metric key matches a Zabbix item key you create on the host.
 * Import the template at /metrics/zabbix-template to get started.
 */

const express = require('express');
const router  = express.Router();
const { pool }  = require('../db');
const redis     = require('../redis');
const os        = require('os');

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
  const now        = Date.now();
  const memUsage   = process.memoryUsage();
  const loadAvg    = os.loadavg();
  const freemem    = os.freemem();
  const totalmem   = os.totalmem();
  const uptimeSec  = process.uptime();

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

  // Node count (HA)
  const { rows: nodeRows } = await pool.query(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '60 seconds') AS online
    FROM nodes
  `).catch(() => ({ rows: [{}] }));
  const nodes = nodeRows[0] || {};

  return {
    // Identity
    node_id:   process.env.NODE_ID || os.hostname(),
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(uptimeSec),

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

    // PostgreSQL
    pg_connections_total:    parseInt(pg.total_connections, 10)  || 0,
    pg_connections_active:   parseInt(pg.active_connections, 10) || 0,
    pg_connections_idle:     parseInt(pg.idle_connections, 10)   || 0,

    // NTP
    ntp_min_stratum:         ntp.min_stratum ? parseInt(ntp.min_stratum, 10) : null,
    ntp_reachable_servers:   parseInt(ntp.reachable_count, 10) || 0,
    ntp_total_servers:       parseInt(ntp.total_count, 10)     || 0,
    ntp_synced:              (parseInt(ntp.reachable_count, 10) || 0) > 0,

    // HA cluster
    ha_nodes_total:          parseInt(nodes.total, 10)  || 1,
    ha_nodes_online:         parseInt(nodes.online, 10) || 1,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /metrics  — main JSON metrics blob
router.get('/', metricsAuth, async (req, res) => {
  try {
    const metrics = await collectMetrics();
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /metrics/zabbix-template  — download a basic Zabbix host template XML
// (users import this into Zabbix to create all items automatically)
router.get('/zabbix-template', metricsAuth, async (req, res) => {
  const metrics = await collectMetrics().catch(() => ({}));
  const keys    = Object.keys(metrics).filter(k => !['node_id','timestamp'].includes(k));
  const host    = process.env.APP_URL || 'http://localhost:3001';
  const token   = req.headers['x-metrics-token'] || req.query.token || '';

  const items = keys.map(k => {
    const isFloat = typeof metrics[k] === 'number' && !Number.isInteger(metrics[k]);
    return `
    <item>
      <name>ClassGuard: ${k.replace(/_/g, ' ')}</name>
      <type>19</type><!-- HTTP agent -->
      <key>classguard.${k}</key>
      <url>${host}/metrics</url>
      <headers>
        <header><name>X-Metrics-Token</name><value>${token}</value></header>
      </headers>
      <posts/>
      <status_codes>200</status_codes>
      <json_output>1</json_output>
      <output_format>3</output_format>
      <preprocessing>
        <step>
          <type>12</type><!-- JSONPath -->
          <params>$.${k}</params>
        </step>
      </preprocessing>
      <value_type>${isFloat ? '0' : '3'}</value_type><!-- 0=float, 3=unsigned -->
      <delay>60</delay>
    </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<zabbix_export>
  <version>6.0</version>
  <hosts>
    <host>
      <host>ClassGuard</host>
      <name>ClassGuard Network Safety</name>
      <items>${items}
      </items>
    </host>
  </hosts>
</zabbix_export>`;

  res.set('Content-Type', 'application/xml');
  res.set('Content-Disposition', 'attachment; filename="classguard-zabbix-template.xml"');
  res.send(xml);
});

module.exports = router;
