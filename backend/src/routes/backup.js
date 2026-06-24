// Encrypted export/import of district configuration for moving to new
// hardware. See services/configBackup.js for exactly what is and isn't
// included and why. Export is delegable (read-only, low blast radius);
// restore is hardcoded superadmin-only, same tier as VPN CA/HA promote/
// TLS issuance -- a bad restore can overwrite the whole district's
// configuration in a single request.
const express = require('express');
const multer  = require('multer');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireMinRole }    = require('../middleware/roles');
const configBackup = require('../services/configBackup');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

router.post('/export', authenticate, requirePermission('backup_export'), async (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase || passphrase.length < 8) {
    return res.status(400).json({ error: 'A passphrase of at least 8 characters is required' });
  }
  try {
    const buffer = await configBackup.createBackup(passphrase);
    const filename = `classguard-backup-${new Date().toISOString().slice(0, 10)}.cgbk`;
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  } catch (err) {
    console.error('[backup] export error:', err.message);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// No passphrase needed -- the header (created-at, ClassGuard version,
// table list) is stored in cleartext specifically so an admin can confirm
// "is this the right file" before committing to the destructive restore
// step below.
router.post('/preview', authenticate, requireMinRole('superadmin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    res.json(configBackup.previewBackup(req.file.buffer));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/restore', authenticate, requireMinRole('superadmin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { passphrase } = req.body;
  if (!passphrase) return res.status(400).json({ error: 'Passphrase is required' });

  try {
    const result = await configBackup.restoreBackup(req.file.buffer, passphrase);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
