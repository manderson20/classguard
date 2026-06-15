const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

// Phase 4

router.get('/', authenticate, requireMinRole('teacher'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.post('/', authenticate, requireMinRole('teacher'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.post('/:id/sync-roster', authenticate, requireMinRole('teacher'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.post('/lessons', authenticate, requireMinRole('teacher'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.put('/lessons/:id', authenticate, requireMinRole('teacher'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.delete('/lessons/:id', authenticate, requireMinRole('teacher'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

module.exports = router;
