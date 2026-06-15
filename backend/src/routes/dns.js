const { Router } = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

const router = Router();

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
    student_id, domain, action,
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

  // Teachers can only see their own students
  if (req.user.role === 'teacher') {
    conditions.push(`user_id IN (
      SELECT cm.user_id FROM class_members cm
      JOIN classes c ON c.id = cm.class_id
      WHERE c.teacher_id = $${values.length + 1}
    )`);
    values.push(req.user.userId);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [{ rows: logs }, { rows: countRow }] = await Promise.all([
    query(
      `SELECT dl.*, u.full_name AS student_name, u.email AS student_email
       FROM dns_logs dl
       LEFT JOIN users u ON u.id = dl.user_id
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
    const conditions = [
      'bucket >= $1',
      'bucket <= $2',
    ];
    const values = [fromTs, toTs];

    if (student_id) {
      conditions.push(`user_id = $${values.length + 1}`);
      values.push(student_id);
    }
    if (req.user.role === 'teacher') {
      conditions.push(`user_id IN (
        SELECT cm.user_id FROM class_members cm
        JOIN classes c ON c.id = cm.class_id
        WHERE c.teacher_id = $${values.length + 1}
      )`);
      values.push(req.user.userId);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await query(
      `SELECT bucket, action, SUM(total_queries) AS total_queries, SUM(unique_domains) AS unique_domains
       FROM dns_stats_hourly
       ${where}
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
      SELECT cm.user_id FROM class_members cm
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

  const [totals, topDomains, topStudents, hourly] = await Promise.all([
    // Overall totals from continuous aggregate (fast)
    query(
      `SELECT action, SUM(total_queries)::int AS count
       FROM dns_stats_hourly
       WHERE bucket >= $1
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
    // Hourly trend from continuous aggregate
    query(
      `SELECT bucket, action, SUM(total_queries)::int AS count
       FROM dns_stats_hourly
       WHERE bucket >= $1
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
  const allowed = ['upstream_primary','upstream_secondary','block_page_ip','cache_ttl'];
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

module.exports = router;
