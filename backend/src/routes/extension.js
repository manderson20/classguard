const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

// Phase 5

router.post('/checkin', authenticate, (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 5' });
});

router.get('/policy', authenticate, (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 5' });
});

router.post('/screenshot', authenticate, (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 5' });
});

module.exports = router;
