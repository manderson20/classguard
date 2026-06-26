const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { authenticate }      = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const infoseciq = require('../services/infosecIq');

const auth = [authenticate, requirePermission('integrations')];

// ---------------------------------------------------------------------------
// Settings / credentials
// ---------------------------------------------------------------------------

router.get('/settings', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings
       WHERE key IN ('infoseciq_base_url','infoseciq_api_key','last_infoseciq_sync')`
    );
    const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({
      base_url:  cfg.infoseciq_base_url || '',
      api_key:   cfg.infoseciq_api_key  ? '***' : '',   // never return the real key
      has_key:   !!cfg.infoseciq_api_key,
      last_sync: cfg.last_infoseciq_sync || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', ...auth, async (req, res) => {
  const { base_url, api_key } = req.body;
  try {
    const pairs = [
      ['infoseciq_base_url', base_url || 'https://api.infosecinstitute.com/iqv2'],
    ];
    if (api_key && api_key !== '***') pairs.push(['infoseciq_api_key', api_key]);
    for (const [key, value] of pairs) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
    }
    res.json({ saved: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/test', ...auth, async (req, res) => {
  try {
    const result = await infoseciq.testConnection();
    res.json(result);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

router.post('/sync', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  infoseciq.syncAll()
    .then(r => console.log('[infoseciq] sync complete:', JSON.stringify(r)))
    .catch(err => console.error('[infoseciq] sync error:', err.message));
});

router.post('/sync/learners', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  infoseciq.syncLearners()
    .catch(err => console.error('[infoseciq] learner sync:', err.message));
});

router.post('/sync/campaigns', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  infoseciq.syncCampaigns()
    .catch(err => console.error('[infoseciq] campaign sync:', err.message));
});

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

router.get('/summary', ...auth, async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*)                                                          AS total_learners,
        ROUND(AVG(training_completion_pct), 1)                           AS avg_completion_pct,
        ROUND(AVG(risk_score), 1)                                        AS avg_risk_score,
        COUNT(*) FILTER (WHERE training_completion_pct >= 100)           AS fully_trained,
        COUNT(*) FILTER (WHERE training_completion_pct < 100)            AS incomplete,
        COUNT(*) FILTER (WHERE risk_score > 70)                          AS high_risk_count,
        ROUND(AVG(phishing_susceptibility), 1)                           AS avg_susceptibility
      FROM infoseciq_learners
    `);

    const { rows: [campStats] } = await pool.query(`
      SELECT
        COUNT(*)                                                          AS total_campaigns,
        COUNT(*) FILTER (WHERE status ILIKE 'active' OR status ILIKE 'running') AS active_campaigns,
        ROUND(AVG(click_rate), 1)                                         AS avg_click_rate,
        ROUND(AVG(report_rate), 1)                                        AS avg_report_rate,
        SUM(clicks)                                                       AS total_clicks,
        SUM(reports)                                                      AS total_reports,
        SUM(emails_sent)                                                  AS total_sent
      FROM infoseciq_campaigns
    `);

    const { rows: recentCampaigns } = await pool.query(`
      SELECT id, name, status, start_date, end_date, click_rate, report_rate,
             recipients_total, clicks, reports
      FROM infoseciq_campaigns
      ORDER BY COALESCE(end_date, start_date) DESC
      LIMIT 5
    `);

    const { rows: [syncInfo] } = await pool.query(
      `SELECT value FROM settings WHERE key = 'last_infoseciq_sync'`
    );

    res.json({
      learners:        stats,
      campaigns:       campStats,
      recentCampaigns,
      lastSync:        syncInfo?.value || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Learners
// ---------------------------------------------------------------------------

router.get('/learners', ...auth, async (req, res) => {
  const { q, dept, sort = 'risk_score', order = 'desc', limit = 100, offset = 0 } = req.query;
  const allowed = ['risk_score','training_completion_pct','last_name','phishing_susceptibility'];
  const col = allowed.includes(sort) ? sort : 'risk_score';
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  try {
    const conditions = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length})`);
    }
    if (dept) {
      params.push(dept);
      conditions.push(`department = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(parseInt(limit) || 100);
    params.push(parseInt(offset) || 0);
    const { rows } = await pool.query(
      `SELECT id, email, first_name, last_name, department,
              risk_score, training_completion_pct, courses_assigned, courses_completed,
              phishing_susceptibility, last_activity_at, last_synced_at
       FROM infoseciq_learners
       ${where}
       ORDER BY ${col} ${dir} NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const { rows: [cnt] } = await pool.query(
      `SELECT COUNT(*) AS total FROM infoseciq_learners ${where}`,
      params.slice(0, -2)
    );

    const { rows: depts } = await pool.query(
      `SELECT DISTINCT department FROM infoseciq_learners WHERE department IS NOT NULL ORDER BY department`
    );

    res.json({ learners: rows, total: parseInt(cnt.total), departments: depts.map(d => d.department) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /infoseciq/learners/by-email/:email — for user detail page cross-reference
router.get('/learners/by-email/:email', ...auth, async (req, res) => {
  try {
    const { rows: [learner] } = await pool.query(
      `SELECT * FROM infoseciq_learners WHERE email ILIKE $1 LIMIT 1`,
      [req.params.email]
    );
    if (!learner) return res.status(404).json({ error: 'Not found' });

    // Also fetch their phishing results
    const { rows: results } = await pool.query(`
      SELECT icr.*, ic.name AS campaign_name, ic.start_date, ic.end_date
      FROM infoseciq_campaign_results icr
      JOIN infoseciq_campaigns ic ON ic.id = icr.campaign_id
      WHERE icr.email ILIKE $1
      ORDER BY icr.sent_at DESC
      LIMIT 10
    `, [req.params.email]);

    res.json({ ...learner, phishing_history: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

router.get('/campaigns', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, status, start_date, end_date, recipients_total, emails_sent,
             opens, clicks, reports, click_rate, report_rate, last_synced_at
      FROM infoseciq_campaigns
      ORDER BY COALESCE(end_date, start_date) DESC NULLS LAST
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/campaigns/:id', ...auth, async (req, res) => {
  try {
    const { rows: [campaign] } = await pool.query(
      `SELECT * FROM infoseciq_campaigns WHERE id = $1`, [req.params.id]
    );
    if (!campaign) return res.status(404).json({ error: 'Not found' });

    const { rows: results } = await pool.query(`
      SELECT email, first_name, last_name, department,
             sent_at, opened_at, clicked_at, reported_at
      FROM infoseciq_campaign_results
      WHERE campaign_id = $1
      ORDER BY last_name, first_name
    `, [req.params.id]);

    const clickers  = results.filter(r => r.clicked_at);
    const reporters = results.filter(r => r.reported_at);

    res.json({ ...campaign, results, clickers, reporters });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
