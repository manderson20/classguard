const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

// Phase 4

router.get('/', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.post('/', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.get('/:id', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.put('/:id', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.delete('/:id', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.post('/:id/clone', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.get('/:id/rules', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.post('/:id/rules', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

router.delete('/:id/rules/:ruleId', authenticate, requireMinRole('admin'), (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

module.exports = router;
