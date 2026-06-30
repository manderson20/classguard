// Chromebook Lost Mode -- find a missing device's last known signal and
// optionally disable it remotely. Two distinct, independent data sources
// feed "where might it be," in order of how good the signal actually is:
//   1. UniFi access point (network_clients.ap_name/ssid/lastSeen, via the
//      existing getUnifiedDevices() consolidation) -- only real if the
//      device is CURRENTLY associated to school WiFi.
//   2. Google's last-known IP + last-sync time (integration_devices,
//      synced from the Directory API) -- works even after the device left
//      the network, but it's an IP, not a place; only useful at all if you
//      separately know which subnet maps to which building.
// There is no GPS/geolocation and no historical AP trail -- neither Google's
// API nor anything else wired up here provides either. See services/google.js
// for why the disable action's lock-screen message can't be templated
// per-incident -- that's a Google Admin Console limitation, not ours.
const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermissionIfAdmin } = require('../middleware/permissions');
const { getUnifiedDevices } = require('../services/deviceConsolidation');
const google = require('../services/google');

const router = Router();
const auth = [authenticate, requireMinRole('admin'), requirePermissionIfAdmin('lost_mode')];

router.get('/search', ...auth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.status(400).json({ error: 'Search query must be at least 2 characters' });

  const unified = await getUnifiedDevices();
  const needle = q.toLowerCase();
  // This is "Chromebook" Lost Mode specifically -- getUnifiedDevices() spans
  // every integration source (Snipe-IT also tracks cameras, switches, etc.),
  // so scope to devices with a Google Admin (ChromeOS) record to avoid
  // surfacing unrelated assets that have nothing to do with student devices.
  const matches = unified.filter(d =>
    d.sources.some(s => s.source === 'google_admin') &&
    ((d.deviceName    || '').toLowerCase().includes(needle) ||
     (d.serialNumber  || '').toLowerCase().includes(needle) ||
     (d.assignedEmail || '').toLowerCase().includes(needle) ||
     (d.assignedUser  || '').toLowerCase().includes(needle))
  ).slice(0, 25);

  res.json(matches);
});

router.get('/:key', ...auth, async (req, res) => {
  const unified = await getUnifiedDevices();
  const device = unified.find(d => d.key === req.params.key);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  // Google's chromeosdevices.action() needs Google's own deviceId, which
  // only the google_admin source row carries (Snipe-IT/Mosyle don't).
  const googleSource = device.sources.find(s => s.source === 'google_admin');
  res.json({ ...device, googleDeviceId: googleSource?.externalId || null });
});

router.post('/:key/action', ...auth, async (req, res) => {
  const { action } = req.body;
  if (!['disable', 'reenable'].includes(action)) return res.status(400).json({ error: 'action must be "disable" or "reenable"' });

  const unified = await getUnifiedDevices();
  const device = unified.find(d => d.key === req.params.key);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const googleSource = device.sources.find(s => s.source === 'google_admin');
  if (!googleSource) return res.status(400).json({ error: 'This device has no Google Admin record -- the disable/reenable action only works for Chromebooks managed in Google Workspace.' });

  try {
    await google.setChromeDeviceAction(googleSource.externalId, action, req.user.userId);
    res.json({ ok: true, action });
  } catch (err) {
    const status = err.code === 403 || /permission|forbidden|insufficient/i.test(err.message) ? 403 : 500;
    const message = status === 403
      ? `Google rejected this action -- your service account's domain-wide delegation likely doesn't have the write scope yet. Add https://www.googleapis.com/auth/admin.directory.device.chromeos in Admin Console > Security > API Controls > Domain-wide Delegation, then try again. (${err.message})`
      : err.message;
    res.status(status).json({ error: message });
  }
});

module.exports = router;
