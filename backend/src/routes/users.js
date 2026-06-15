const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

// Phase 8 — Google Workspace sync fills in user data
// Phase 7 — Admin Console user management UI

router.get('/', authenticate, requireMinRole('admin'), async (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 8' });
});

router.get('/:id', authenticate, requireMinRole('admin'), async (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 8' });
});

router.put('/:id/role', authenticate, requireMinRole('superadmin'), async (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 8' });
});

router.get('/:id/effective-policy', authenticate, requireMinRole('teacher'), async (req, res) => {
  res.status(501).json({ error: 'Not yet implemented — Phase 4' });
});

module.exports = router;
