const { Router } = require('express');
const dnsPromises = require('dns').promises;
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { insertDnsLogBatch } = require('../services/scheduler');

const router = Router();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// GET /api/v1/dns/resolve  — live lookup for troubleshooting
// Queries a public resolver directly (not ClassGuard's own DNS engine), so
// the answer reflects what the domain actually resolves to in the real
// world — useful when checking whether a block reason still makes sense,
// or whether a "blocked" entry in the logs is masking the real answer.
// ---------------------------------------------------------------------------
router.get('/resolve', authenticate, requireMinRole('teacher'), async (req, res) => {
  const domain = (req.query.domain || '').trim();
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const resolver = new dnsPromises.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);

  const result = { domain, a: [], aaaa: [], cname: [], error: null };
  try {
    result.cname = await withTimeout(resolver.resolveCname(domain), 4000);
  } catch { /* no CNAME */ }
  try {
    result.a = await withTimeout(resolver.resolve4(domain), 4000);
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') {
      // fine — try AAAA before giving up
    } else {
      result.error = e.message === 'timeout' ? 'Lookup timed out' : (e.code || e.message);
    }
  }
  try {
    result.aaaa = await withTimeout(resolver.resolve6(domain), 4000);
  } catch { /* no AAAA */ }

  if (!result.error && result.a.length === 0 && result.aaaa.length === 0 && result.cname.length === 0) {
    result.error = 'No A/AAAA/CNAME record found (NXDOMAIN or no data)';
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/v1/dns/logs
// Paginated, filterable DNS query history backed by TimescaleDB
//
// Query params:
//   student_id  — filter to one student
//   domain      — substring match on domain
//   action      — allowed | blocked | unknown
//   from        — ISO8601 start (default: 24h ago)
//   to          — ISO8601 end   (default: now)
//   page        — 1-based (default: 1)
//   limit       — rows per page (default: 50, max: 500)
// ---------------------------------------------------------------------------
router.get('/logs', authenticate, requireMinRole('teacher'), async (req, res) => {
  const {
    student_id, domain, action, lesson_session_id,
    from, to,
    page = 1, limit = 50,
  } = req.query;

  const PAGE_LIMIT = Math.min(parseInt(limit, 10) || 50, 500);
  const OFFSET     = (Math.max(parseInt(page, 10) || 1, 1) - 1) * PAGE_LIMIT;

  const conditions = [];
  const values     = [];

  const fromTs = from ? new Date(from) : new Date(Date.now() - 86400_000);
  const toTs   = to   ? new Date(to)   : new Date();

  conditions.push(`queried_at >= $${values.length + 1}`); values.push(fromTs);
  conditions.push(`queried_at <= $${values.length + 1}`); values.push(toTs);

  if (student_id) {
    conditions.push(`user_id = $${values.length + 1}`);
    values.push(student_id);
  }
  if (domain) {
    conditions.push(`domain ILIKE $${values.length + 1}`);
    values.push(`%${domain}%`);
  }
  if (action && ['allowed','blocked','unknown'].includes(action)) {
    conditions.push(`action = $${values.length + 1}`);
    values.push(action);
  }
  if (lesson_session_id) {
    conditions.push(`lesson_session_id = $${values.length + 1}`);
    values.push(lesson_session_id);
  }

  // Teachers can only see their own students
  if (req.user.role === 'teacher') {
    conditions.push(`user_id IN (
      SELECT cm.student_id FROM class_members cm
      JOIN classes c ON c.id = cm.class_id
      WHERE c.teacher_id = $${values.length + 1}
    )`);
    values.push(req.user.userId);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [{ rows: logs }, { rows: countRow }] = await Promise.all([
    query(
      `SELECT dl.*, u.full_name AS student_name, u.email AS student_email,
              COALESCE(ip.hostname, ph.display_name) AS device_name
       FROM dns_logs dl
       LEFT JOIN users u ON u.id = dl.user_id
       LEFT JOIN ip_addresses ip ON dl.user_id IS NULL AND ip.ip = dl.source_ip
       LEFT JOIN phones ph ON dl.user_id IS NULL AND ip.id IS NULL AND ph.ip_address = dl.source_ip
       ${where}
       ORDER BY dl.queried_at DESC
       LIMIT ${PAGE_LIMIT} OFFSET ${OFFSET}`,
      values
    ),
    query(
      `SELECT COUNT(*) AS total FROM dns_logs ${where}`,
      values
    ),
  ]);

  res.json({
    total:   parseInt(countRow[0].total, 10),
    page:    parseInt(page, 10),
    limit:   PAGE_LIMIT,
    results: logs,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/dns/stats
// Aggregated DNS statistics using the TimescaleDB continuous aggregate
//
// Query params:
//   student_id  — filter to one student
//   from        — ISO8601 start (default: 24h ago)
//   to          — ISO8601 end   (default: now)
//   bucket      — 1hour | 1day (default: 1hour)
// ---------------------------------------------------------------------------
router.get('/stats', authenticate, requireMinRole('teacher'), async (req, res) => {
  const {
    student_id,
    from, to,
    bucket = '1hour',
  } = req.query;

  const fromTs = from ? new Date(from) : new Date(Date.now() - 86400_000);
  const toTs   = to   ? new Date(to)   : new Date();

  // Use the continuous aggregate for hourly granularity; fall back to direct
  // time_bucket query for daily buckets (CA is hourly only).
  const useCA = bucket === '1hour';

  if (useCA) {
    const values = [fromTs, toTs];
    let userFilter = '';
    if (student_id) {
      values.push(student_id);
      userFilter += ` AND user_id = $${values.length}`;
    }
    if (req.user.role === 'teacher') {
      values.push(req.user.userId);
      userFilter += ` AND user_id IN (
        SELECT cm.student_id FROM class_members cm
        JOIN classes c ON c.id = cm.class_id
        WHERE c.teacher_id = $${values.length}
      )`;
    }

    // The continuous aggregate lags behind real time (refresh policy keeps a
    // short window unmaterialized) — union in a live tail straight from
    // dns_logs for anything newer than the CA has caught up to, so recent
    // activity never just appears to vanish on a "last 24h" view.
    const { rows } = await query(
      `SELECT bucket, action, SUM(total_queries)::bigint AS total_queries, SUM(unique_domains)::bigint AS unique_domains
       FROM (
         SELECT bucket, action, total_queries, unique_domains
         FROM dns_stats_hourly
         WHERE bucket >= $1 AND bucket <= $2 ${userFilter}
         UNION ALL
         SELECT time_bucket('1 hour', queried_at) AS bucket, action,
                COUNT(*) AS total_queries, COUNT(DISTINCT domain) AS unique_domains
         FROM dns_logs
         WHERE queried_at > COALESCE((SELECT MAX(bucket) + INTERVAL '1 hour' FROM dns_stats_hourly), '-infinity'::timestamptz)
           AND queried_at >= $1 AND queried_at <= $2 ${userFilter}
         GROUP BY time_bucket('1 hour', queried_at), action
       ) combined
       GROUP BY bucket, action
       ORDER BY bucket ASC`,
      values
    );
    return res.json(rows);
  }

  // Daily bucket — query raw table (acceptable for short date ranges)
  const conditions = [
    `queried_at >= $1`,
    `queried_at <= $2`,
  ];
  const values = [fromTs, toTs];

  if (student_id) {
    conditions.push(`user_id = $${values.length + 1}`);
    values.push(student_id);
  }
  if (req.user.role === 'teacher') {
    conditions.push(`user_id IN (
      SELECT cm.student_id FROM class_members cm
      JOIN classes c ON c.id = cm.class_id
      WHERE c.teacher_id = $${values.length + 1}
    )`);
    values.push(req.user.userId);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { rows } = await query(
    `SELECT time_bucket('1 day', queried_at) AS bucket,
            action,
            COUNT(*) AS total_queries,
            COUNT(DISTINCT domain) AS unique_domains
     FROM dns_logs
     ${where}
     GROUP BY bucket, action
     ORDER BY bucket ASC`,
    values
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// GET /api/v1/dns/summary  (admin only)
// Quick-read dashboard card: totals, block rate, top domains, top students
// All queries use the TimescaleDB continuous aggregate or indexed columns.
// ---------------------------------------------------------------------------
router.get('/summary', authenticate, requireMinRole('admin'), async (req, res) => {
  const hours = Math.min(parseInt(req.query.hours, 10) || 24, 168);
  const from  = new Date(Date.now() - hours * 3600_000);

  // The continuous aggregate lags real time by its refresh window — union in
  // a live tail from raw dns_logs for anything it hasn't caught up to yet,
  // same as /stats, so this card doesn't look frozen during active use.
  const caTail = `
    UNION ALL
    SELECT time_bucket('1 hour', queried_at) AS bucket, action, COUNT(*) AS count
    FROM dns_logs
    WHERE queried_at > COALESCE((SELECT MAX(bucket) + INTERVAL '1 hour' FROM dns_stats_hourly), '-infinity'::timestamptz)
      AND queried_at >= $1
    GROUP BY time_bucket('1 hour', queried_at), action
  `;

  const [totals, topDomains, topStudents, hourly] = await Promise.all([
    // Overall totals from continuous aggregate (fast) + live tail
    query(
      `SELECT action, SUM(count)::int AS count FROM (
         SELECT bucket, action, total_queries AS count FROM dns_stats_hourly WHERE bucket >= $1
         ${caTail}
       ) combined
       GROUP BY action`,
      [from]
    ),
    // Top blocked domains
    query(
      `SELECT domain, COUNT(*) AS count
       FROM dns_logs
       WHERE action = 'blocked' AND queried_at >= $1
       GROUP BY domain
       ORDER BY count DESC
       LIMIT 10`,
      [from]
    ),
    // Most active students
    query(
      `SELECT dl.user_id, u.full_name AS student_name, COUNT(*) AS count
       FROM dns_logs dl
       JOIN users u ON u.id = dl.user_id
       WHERE dl.queried_at >= $1
       GROUP BY dl.user_id, u.full_name
       ORDER BY count DESC
       LIMIT 10`,
      [from]
    ),
    // Hourly trend from continuous aggregate + live tail
    query(
      `SELECT bucket, action, SUM(count)::int AS count FROM (
         SELECT bucket, action, total_queries AS count FROM dns_stats_hourly WHERE bucket >= $1
         ${caTail}
       ) combined
       GROUP BY bucket, action
       ORDER BY bucket ASC`,
      [from]
    ),
  ]);

  const actionTotals = Object.fromEntries(totals.rows.map(r => [r.action, r.count]));
  const total   = Object.values(actionTotals).reduce((a, b) => a + parseInt(b, 10), 0);
  const blocked = parseInt(actionTotals.blocked || 0, 10);

  res.json({
    period_hours: hours,
    total,
    blocked,
    allowed:    parseInt(actionTotals.allowed  || 0, 10),
    unknown:    parseInt(actionTotals.unknown  || 0, 10),
    block_rate: total > 0 ? Math.round((blocked / total) * 1000) / 10 : 0,
    top_blocked_domains: topDomains.rows,
    top_active_students: topStudents.rows,
    hourly_trend:        hourly.rows,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/dns/settings  (admin only — Phase 6 UI)
// PUT /api/v1/dns/settings
// ---------------------------------------------------------------------------
router.get('/settings', authenticate, requireMinRole('admin'), async (req, res) => {
  const { rows } = await query(
    "SELECT key, value FROM settings WHERE key LIKE 'dns.%'"
  );
  const settings = Object.fromEntries(rows.map(r => [r.key.replace('dns.', ''), r.value]));
  res.json(settings);
});

router.put('/settings', authenticate, requireMinRole('admin'), async (req, res) => {
  const allowed = ['upstream_ipv4','upstream_ipv6','block_page_ip','block_page_ipv6','cache_ttl',
                   'dhcp_auto_register','dhcp_auto_register_zone_id'];
  const entries = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (entries.length === 0) return res.status(400).json({ error: 'No valid settings provided' });

  for (const [key, value] of entries) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`dns.${key}`, String(value)]
    );
  }
  res.json({ updated: entries.map(([k]) => k) });
});

// ---------------------------------------------------------------------------
// POST /api/v1/dns/internal/dns-logs/bulk
// Internal-secret only (see middleware/auth.js's isInternalRequest). A
// standby node forwards DNS query logs here when its own Postgres is a
// read-only streaming replica and can't write dns_logs locally — see
// services/scheduler.js's insertOrForwardDnsLogs. Reuses the exact same
// insert path as the local drain, so there's no behavioral difference
// between a log written locally vs. forwarded from a standby.
// ---------------------------------------------------------------------------
router.post('/internal/dns-logs/bulk', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records (non-empty array) is required' });
  }
  try {
    await insertDnsLogBatch(records);
    res.json({ inserted: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
