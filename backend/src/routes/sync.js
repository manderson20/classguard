const express = require('express');
const router  = express.Router();
const { authenticate }    = require('../middleware/auth');
const { requireMinRole }  = require('../middleware/roles');
const { syncAll }         = require('../services/google');
const { pool }            = require('../db');

// ---------------------------------------------------------------------------
// POST /api/v1/sync/google
// Trigger a full Google Workspace sync (admin+). Runs async; returns immediately.
// ---------------------------------------------------------------------------
router.post('/google', authenticate, requireMinRole('admin'), async (req, res) => {
  // Respond immediately — sync can take tens of seconds for large directories
  res.json({ status: 'started', message: 'Google Workspace sync initiated' });

  syncAll(req.user.id).catch(err => {
    console.error('[sync] Google Workspace sync failed:', err.message);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/sync/status
// Return last sync time and current user/group counts.
// ---------------------------------------------------------------------------
router.get('/status', authenticate, requireMinRole('admin'), async (req, res) => {
  try {
    const [syncRow, userRow, groupRow] = await Promise.all([
      pool.query(`SELECT value FROM settings WHERE key = 'last_google_sync'`),
      pool.query(`SELECT COUNT(*) AS count FROM users WHERE is_active = true`),
      pool.query(`SELECT COUNT(*) AS count FROM groups`),
    ]);

    res.json({
      lastSync:    syncRow.rows[0]?.value ?? null,
      activeUsers: parseInt(userRow.rows[0].count,  10),
      groups:      parseInt(groupRow.rows[0].count, 10),
    });
  } catch (err) {
    console.error('[sync] status error:', err);
    res.status(500).json({ error: 'Failed to retrieve sync status' });
  }
});

module.exports = router;
