const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

// Phase 8

router.post('/google', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 8' });
});

router.get('/status', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 8' });
});

module.exports = router;
