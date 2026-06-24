// Dependency vulnerability scan results -- see services/securityScan.js
// for what's actually scanned and the honest limits of the CISA KEV
// cross-reference. Gated by its own permission (sensitive: true) since
// "here's exactly which of our packages are currently vulnerable, and to
// what" is itself useful intel to someone who shouldn't have it.
const { Router } = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const securityScan = require('../services/securityScan');

const router = Router();
const auth = [authenticate, requirePermission('security_scan')];

router.get('/scan/latest', ...auth, async (req, res) => {
  const { rows: [scan] } = await pool.query(
    `SELECT * FROM security_scans ORDER BY started_at DESC LIMIT 1`
  );
  if (!scan) return res.json({ scan: null, findings: [] });

  const { rows: findings } = await pool.query(
    `SELECT * FROM security_scan_findings WHERE scan_id = $1
     ORDER BY is_kev DESC, severity = 'critical' DESC, severity = 'high' DESC, severity = 'moderate' DESC, package_name`,
    [scan.id]
  );
  res.json({ scan, findings });
});

router.get('/scan/history', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, started_at, completed_at, status, error, summary FROM security_scans
     ORDER BY started_at DESC LIMIT 30`
  );
  res.json(rows);
});

router.post('/scan/run', ...auth, async (req, res) => {
  try {
    const result = await securityScan.runScan();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
