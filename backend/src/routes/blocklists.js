const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

// Phase 3

router.get('/', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 3' });
});

router.post('/', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 3' });
});

router.delete('/:id', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 3' });
});

router.post('/:id/sync', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 3' });
});

router.get('/:id/preview', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 3' });
});

module.exports = router;
