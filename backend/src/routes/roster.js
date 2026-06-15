const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const classroom  = require('../services/googleClassroom');
const oneRoster  = require('../services/oneRoster');

const auth = [authenticate, requireMinRole('admin')];

// ---------------------------------------------------------------------------
// Google Classroom sync
// ---------------------------------------------------------------------------

// POST /api/v1/roster/sync/classroom  — async, returns immediately
router.post('/sync/classroom', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  classroom.syncClassroom(req.user.id, msg => console.log('[classroom]', msg))
    .catch(err => console.error('[classroom] sync error:', err.message));
});

// GET /api/v1/roster/classroom/status
router.get('/classroom/status', ...auth, async (req, res) => {
  try {
    const { rows: settings } = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('last_classroom_sync')`
    );
    const cfg = Object.fromEntries(settings.map(r => [r.key, r.value]));

    const { rows: counts } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM classes WHERE sync_source = 'google_classroom') AS classes,
        (SELECT COUNT(*) FROM class_members WHERE sync_source = 'google_classroom') AS enrollments,
        (SELECT COUNT(*) FROM users WHERE sync_source = 'google') AS users
    `);

    const { rows: mapped } = await pool.query(
      `SELECT m.*, c.name AS class_name
       FROM classroom_course_map m
       LEFT JOIN classes c ON c.id = m.class_id
       ORDER BY m.last_sync DESC LIMIT 50`
    );

    res.json({
      configured:   !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH),
      last_sync:    cfg.last_classroom_sync || null,
      counts:       counts[0],
      mapped_courses: mapped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// OneRoster sources CRUD
// ---------------------------------------------------------------------------

router.get('/oneroster/sources', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, base_url, school_year, org_filter, is_active, last_sync, last_error, created_at
     FROM oneroster_sources ORDER BY created_at`
  );
  res.json(rows);
});

router.post('/oneroster/sources', ...auth, async (req, res) => {
  const { name, base_url, client_id, client_secret, school_year, org_filter } = req.body;
  if (!name || !base_url || !client_id || !client_secret) {
    return res.status(400).json({ error: 'name, base_url, client_id, client_secret required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO oneroster_sources (name, base_url, client_id, client_secret, school_year, org_filter)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, base_url, school_year, is_active, created_at`,
      [name, base_url, client_id, client_secret, school_year || null, org_filter || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/oneroster/sources/:id', ...auth, async (req, res) => {
  const { name, base_url, client_id, client_secret, school_year, org_filter, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE oneroster_sources SET
         name          = COALESCE($1, name),
         base_url      = COALESCE($2, base_url),
         client_id     = COALESCE($3, client_id),
         client_secret = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE client_secret END,
         school_year   = COALESCE($5, school_year),
         org_filter    = COALESCE($6, org_filter),
         is_active     = COALESCE($7, is_active)
       WHERE id = $8
       RETURNING id, name, base_url, school_year, is_active`,
      [name, base_url, client_id, client_secret || null, school_year, org_filter, is_active ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Source not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/oneroster/sources/:id', ...auth, async (req, res) => {
  await pool.query('DELETE FROM oneroster_sources WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

// POST /api/v1/roster/oneroster/sources/:id/test
router.post('/oneroster/sources/:id/test', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM oneroster_sources WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Source not found' });
    const result = await oneRoster.testConnection(rows[0]);
    res.json(result);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// POST /api/v1/roster/sync/oneroster/:id  — async sync for one source
router.post('/sync/oneroster/:id', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  oneRoster.syncOneRoster(req.params.id, msg => console.log('[oneroster]', msg))
    .catch(async err => {
      console.error('[oneroster] sync error:', err.message);
      await pool.query(
        'UPDATE oneroster_sources SET last_error = $1 WHERE id = $2',
        [err.message, req.params.id]
      ).catch(() => {});
    });
});

// POST /api/v1/roster/sync/oneroster-all  — sync all active sources
router.post('/sync/oneroster-all', ...auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM oneroster_sources WHERE is_active = true');
  res.json({ status: 'started', count: rows.length });
  for (const { id } of rows) {
    oneRoster.syncOneRoster(id, msg => console.log('[oneroster]', msg))
      .catch(err => console.error(`[oneroster] sync ${id}:`, err.message));
  }
});

// ---------------------------------------------------------------------------
// Roster overview (combined sync status)
// ---------------------------------------------------------------------------

router.get('/status', ...auth, async (req, res) => {
  try {
    const [{ rows: settings }, { rows: counts }, { rows: orSources }] = await Promise.all([
      pool.query(`SELECT key, value FROM settings WHERE key IN ('last_classroom_sync','last_google_sync')`),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM classes WHERE sync_source = 'google_classroom') AS classroom_classes,
          (SELECT COUNT(*) FROM classes WHERE sync_source = 'oneroster')        AS oneroster_classes,
          (SELECT COUNT(*) FROM classes WHERE sync_source = 'manual')           AS manual_classes,
          (SELECT COUNT(*) FROM class_members WHERE sync_source = 'google_classroom') AS classroom_enrollments,
          (SELECT COUNT(*) FROM class_members WHERE sync_source = 'oneroster')        AS oneroster_enrollments,
          (SELECT COUNT(*) FROM users WHERE sync_source = 'google')             AS google_users,
          (SELECT COUNT(*) FROM users WHERE sync_source = 'oneroster')          AS oneroster_users
      `),
      pool.query('SELECT id, name, last_sync, last_error, is_active FROM oneroster_sources ORDER BY created_at'),
    ]);

    const cfg = Object.fromEntries(settings.map(r => [r.key, r.value]));
    res.json({
      classroom: {
        configured: !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH),
        last_sync:  cfg.last_classroom_sync || null,
      },
      oneroster:  { sources: orSources },
      counts:     counts[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
