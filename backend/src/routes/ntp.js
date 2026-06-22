const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermission } = require('../middleware/permissions');
const ntp     = require('../services/ntp');
const chrony  = require('../services/chrony');

const auth      = [authenticate, requirePermission('ntp_monitoring')];
const superauth = [authenticate, requireMinRole('superadmin')];

// GET /api/v1/ntp/servers
router.get('/servers', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, p.stratum, p.offset_ms, p.delay_ms, p.jitter_ms,
              p.reachable, p.reference, p.poll_interval, p.checked_at
       FROM ntp_servers s
       LEFT JOIN ntp_peer_status p ON p.server_id = s.id
       ORDER BY s.prefer DESC, s.address`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/ntp/servers
router.post('/servers', ...auth, async (req, res) => {
  const { address, description, prefer = false } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO ntp_servers (address, description, prefer)
       VALUES ($1,$2,$3) RETURNING *`,
      [address, description ?? null, prefer]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Server already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/ntp/servers/:id
router.delete('/servers/:id', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM ntp_servers WHERE id = $1 RETURNING id', [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});

// POST /api/v1/ntp/poll  — trigger an immediate poll of all servers, waits
// for it to finish (a few seconds at most) so the caller can refetch and
// actually see fresh results, instead of guessing how long to wait.
router.post('/poll', ...auth, async (req, res) => {
  try {
    await ntp.pollAll();
    res.json({ status: 'completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ntp/status  — latest cached poll results
router.get('/status', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.address, s.prefer, s.is_active,
              p.stratum, p.offset_ms, p.delay_ms, p.jitter_ms,
              p.reachable, p.reference, p.poll_interval, p.checked_at
       FROM ntp_servers s
       LEFT JOIN ntp_peer_status p ON p.server_id = s.id
       WHERE s.is_active = true
       ORDER BY s.prefer DESC, p.stratum NULLS LAST`
    );
    const synced    = rows.filter(r => r.reachable && r.stratum);
    const minStrat  = synced.length ? Math.min(...synced.map(r => r.stratum)) : null;
    res.json({ servers: rows, stratum: minStrat, synced: synced.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// NTP server (chrony) — config + deployment bundle. Distinct from
// /servers above, which is the external-source-monitoring feature that
// already existed; this is ClassGuard becoming a server itself.
// ---------------------------------------------------------------------------

// GET /api/v1/ntp/server-config
router.get('/server-config', ...auth, async (req, res) => {
  try {
    res.json(await chrony.getNtpConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/ntp/server-config
router.put('/server-config', ...superauth, async (req, res) => {
  const { enabled, upstream_pool, allowed_subnets, local_stratum } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE ntp_server_config SET
         enabled         = COALESCE($1, enabled),
         upstream_pool   = COALESCE($2, upstream_pool),
         allowed_subnets = COALESCE($3, allowed_subnets),
         local_stratum   = COALESCE($4, local_stratum),
         updated_at      = NOW()
       RETURNING *`,
      [enabled ?? null, upstream_pool ?? null, allowed_subnets ?? null, local_stratum ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ntp/server-bundle — chrony.conf + install script for every node
router.get('/server-bundle', ...superauth, async (req, res) => {
  try {
    res.json(await chrony.buildNtpBundle());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// NTP client visibility — which devices are actually polling this node's
// chrony for time, fed by the cron-installed ntp-client-report.sh script
// from the bundle above (chrony itself only exposes a live `chronyc
// clients` snapshot, no log of its own — see services/chrony.js).
// ---------------------------------------------------------------------------

// POST /api/v1/ntp/internal/clients — internal-secret only (see middleware/auth.js
// isInternalRequest); requireMinRole passes naturally for that caller, same
// pattern as extension.js's /internal/tab-events/bulk.
router.post('/internal/clients', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { node_id, clients } = req.body;
  if (!node_id || !Array.isArray(clients)) {
    return res.status(400).json({ error: 'node_id and clients[] required' });
  }
  try {
    for (const c of clients) {
      if (!c.client_address) continue;
      const lastSeenAt = Number(c.seconds_since_last_rx) >= 0
        ? new Date(Date.now() - Number(c.seconds_since_last_rx) * 1000)
        : null;
      await pool.query(
        `INSERT INTO ntp_clients (node_id, client_address, ntp_packets, ntp_dropped, last_seen_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (node_id, client_address) DO UPDATE SET
           ntp_packets  = EXCLUDED.ntp_packets,
           ntp_dropped  = EXCLUDED.ntp_dropped,
           last_seen_at = COALESCE(EXCLUDED.last_seen_at, ntp_clients.last_seen_at),
           updated_at   = NOW()`,
        [node_id, c.client_address, c.ntp_packets || 0, c.ntp_dropped || 0, lastSeenAt]
      );
    }
    res.json({ status: 'ok', count: clients.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ntp/clients — admin UI listing, with device names resolved the
// same way DNS Logs does (IP inventory first, then phone system).
router.get('/clients', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT nc.*, COALESCE(ip.hostname, ph.display_name) AS device_name
       FROM ntp_clients nc
       LEFT JOIN ip_addresses ip ON ip.ip = nc.client_address
       LEFT JOIN phones ph ON ip.id IS NULL AND ph.ip_address = nc.client_address
       ORDER BY nc.last_seen_at DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
