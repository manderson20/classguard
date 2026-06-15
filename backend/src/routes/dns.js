const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

// Phase 2 / Phase 3

router.get('/settings', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 2' });
});

router.put('/settings', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 2' });
});

router.get('/logs', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 3' });
});

router.get('/stats', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 3' });
});

// DNS over HTTPS endpoint (RFC 8484) — Phase 2
router.get('/dns-query', (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 2' });
});

module.exports = router;
