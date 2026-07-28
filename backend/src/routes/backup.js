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
const configBackup    = require('../services/configBackup');
const scheduledBackup = require('../services/scheduledBackup');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

router.post('/export', authenticate, requirePermission('backup_export'), async (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase || passphrase.length < 8) {
    return res.status(400).json({ error: 'A passphrase of at least 8 characters is required' });
  }
  try {
    // Env identity (JWT_SECRET / EXTENSION_SIGNING_KEY) rides along only in
    // superadmin exports — see configBackup.js for why a delegated exporter
    // must not receive it.
    const buffer = await configBackup.createBackup(passphrase, {
      includeEnvIdentity: req.user?.role === 'superadmin',
    });
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

// --- Scheduled backups -------------------------------------------------------
// Everything below is hardcoded superadmin-only: scheduled files always carry
// env identity (JWT_SECRET / EXTENSION_SIGNING_KEY inside the encrypted
// payload), so handing one to a delegated exporter would be the same quiet
// privilege escalation the manual export path guards against per-caller.
const scheduledAuth = [authenticate, requireMinRole('superadmin')];

router.get('/scheduled', ...scheduledAuth, async (req, res) => {
  try {
    const settings = await scheduledBackup.getScheduleSettings();
    res.json({
      files: scheduledBackup.listBackupFiles(),
      passphraseSet: Boolean(settings.passphrase),
      schedule: {
        schedule:  settings.schedule,
        time:      settings.time,
        day:       settings.day,
        retention: settings.retention,
      },
    });
  } catch (err) {
    console.error('[backup] list error:', err.message);
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

router.post('/scheduled/run', ...scheduledAuth, async (req, res) => {
  try {
    const result = await scheduledBackup.runBackup();
    res.json(result);
  } catch (err) {
    console.error('[backup] run-now error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.get('/scheduled/:name', ...scheduledAuth, (req, res) => {
  const full = scheduledBackup.resolveBackupFile(req.params.name);
  if (!full) return res.status(404).json({ error: 'No such backup' });
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${req.params.name}"`,
  });
  res.sendFile(full);
});

router.delete('/scheduled/:name', ...scheduledAuth, (req, res) => {
  if (!scheduledBackup.deleteBackup(req.params.name)) {
    return res.status(404).json({ error: 'No such backup' });
  }
  res.json({ deleted: req.params.name });
});

module.exports = router;
