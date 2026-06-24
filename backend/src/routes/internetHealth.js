// Upstream internet/DNS connectivity — status + history. See
// services/internetHealth.js for what's actually checked and why; this is
// just the read/trigger surface for the Admin Dashboard widget.
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const internetHealth = require('../services/internetHealth');

const auth = [authenticate, requirePermission('internet_monitoring')];

// GET /api/v1/internet-health/status — latest check + recent history, for
// the dashboard widget (current state) and its small recent-checks list.
router.get('/status', ...auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM internet_health_checks ORDER BY checked_at DESC LIMIT 20`
    );
    res.json({ latest: rows[0] || null, history: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/internet-health/check — trigger an immediate check, same
// pattern as ntp.js's POST /poll, so a "Check now" button can show a fresh
// result instead of waiting for the next 2-minute cron tick.
router.post('/check', ...auth, async (req, res) => {
  try {
    const result = await internetHealth.runCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
