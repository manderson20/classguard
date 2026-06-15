const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const config = require('../config');

const auth = [authenticate, requireMinRole('admin')];

// ---------------------------------------------------------------------------
// Self-registration — called on startup to ensure this node is in the DB
// ---------------------------------------------------------------------------
async function registerSelf() {
  const nodeId  = config.node.id;
  const version = process.env.npm_package_version || '0.0.1';
  const apiUrl  = config.appUrl;

  await pool.query(
    `INSERT INTO nodes (node_id, hostname, role, ha_role, api_url, version, last_seen, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),true)
     ON CONFLICT (node_id) DO UPDATE SET
       ha_role = EXCLUDED.ha_role, api_url = EXCLUDED.api_url,
       version = EXCLUDED.version, last_seen = NOW(), is_active = true`,
    [nodeId, process.env.HOSTNAME || nodeId, config.node.role,
     config.node.role === 'primary' ? 'primary' : 'standby', apiUrl, version]
  ).catch(err => console.warn('[ha] self-register:', err.message));
}

// Heartbeat updater — runs every 30s
function startHeartbeat() {
  registerSelf();
  setInterval(async () => {
    await pool.query(
      `UPDATE nodes SET last_seen = NOW() WHERE node_id = $1`,
      [config.node.id]
    ).catch(() => {});
  }, 30_000);
}

// ---------------------------------------------------------------------------
// GET /api/v1/ha/nodes  — list all known nodes with health status
// ---------------------------------------------------------------------------
router.get('/nodes', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT *,
              EXTRACT(EPOCH FROM (NOW() - last_seen)) AS seconds_since_seen
       FROM nodes
       ORDER BY ha_role, created_at`
    );

    // Probe each node's /health endpoint in parallel
    const probed = await Promise.allSettled(
      rows.map(async (n) => {
        if (!n.api_url) return { ...n, healthy: false, probe: null };
        const url = `${n.api_url}/health`;
        try {
          const r = await axios.get(url, { timeout: 3000 });
          return { ...n, healthy: true, probe: r.data };
        } catch {
          return { ...n, healthy: false, probe: null };
        }
      })
    );

    const nodes = probed.map(r => r.status === 'fulfilled' ? r.value : { ...r.reason, healthy: false });
    res.json(nodes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ha/nodes/:nodeId
router.get('/nodes/:nodeId', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM nodes WHERE node_id = $1', [req.params.nodeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/ha/nodes/:nodeId/role  — change ha_role (primary/standby/replica)
router.put('/nodes/:nodeId/role', ...auth, async (req, res) => {
  const { ha_role } = req.body;
  if (!['primary', 'standby', 'replica'].includes(ha_role)) {
    return res.status(400).json({ error: 'ha_role must be primary, standby, or replica' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE nodes SET ha_role = $1 WHERE node_id = $2 RETURNING *',
      [ha_role, req.params.nodeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/ha/nodes/:nodeId  — remove a decommissioned node
router.delete('/nodes/:nodeId', ...auth, async (req, res) => {
  if (req.params.nodeId === config.node.id) {
    return res.status(400).json({ error: 'Cannot remove the current node' });
  }
  const { rows } = await pool.query(
    'DELETE FROM nodes WHERE node_id = $1 RETURNING node_id', [req.params.nodeId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Node not found' });
  res.json({ deleted: true });
});

// GET /api/v1/ha/summary  — quick health summary for dashboard widget
router.get('/summary', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ha_role,
              COUNT(*) AS count,
              COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '60 seconds') AS online
       FROM nodes GROUP BY ha_role`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.startHeartbeat = startHeartbeat;
