// System Health — live status + version for every self-hosted service
// ClassGuard depends on (Kea, Postgres, Redis, nginx, the DNS engine, and
// this API itself). Distinct from /api/v1/integrations/status, which covers
// external API integrations (UniFi, Mosyle, Google, Snipe-IT) — those are a
// different kind of risk (the vendor changes their API, not something we
// control by pinning a version) and already have their own status surface.
const { Router } = require('express');
const axios = require('axios');
const { pool } = require('../db');
const redis = require('../redis');
const { keaCommand } = require('../services/kea');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

const router = Router();
const auth = [authenticate, requireMinRole('admin')];

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
