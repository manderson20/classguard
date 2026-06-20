const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const ntp = require('../services/ntp');

const auth = [authenticate, requireMinRole('admin')];

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

module.exports = router;
