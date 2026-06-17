const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const crypto   = require('crypto');
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const config = require('../config');

const auth = [authenticate, requireMinRole('admin')];

// ---------------------------------------------------------------------------
// Self-registration — upserts this node on startup using node_id as the key
// ---------------------------------------------------------------------------
async function registerSelf() {
  const nodeId  = config.node.id;                     // NODE_ID env var || 'node1'
  const version = process.env.npm_package_version || '0.0.1';
  const apiUrl  = config.appUrl;
  const hostname = process.env.HOSTNAME || nodeId;

  // ON CONFLICT on hostname (existing unique constraint) — also stamps node_id
  await pool.query(
    `INSERT INTO nodes (node_id, hostname, ip, role, ha_role, api_url, version, last_seen, is_active)
     VALUES ($1, $2, '0.0.0.0', $3, $4, $5, $6, NOW(), true)
     ON CONFLICT (hostname) DO UPDATE SET
       node_id   = EXCLUDED.node_id,
       ha_role   = EXCLUDED.ha_role,
       api_url   = EXCLUDED.api_url,
       version   = EXCLUDED.version,
       last_seen = NOW(),
       is_active = true`,
    [nodeId, hostname, config.node.role,
     config.node.role === 'primary' ? 'primary' : 'standby', apiUrl, version]
  ).catch(err => console.warn('[ha] self-register:', err.message));
}

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
// GET /api/v1/ha/nodes
// ---------------------------------------------------------------------------
router.get('/nodes', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT *, EXTRACT(EPOCH FROM (NOW() - last_seen)) AS seconds_since_seen
       FROM nodes ORDER BY ha_role, created_at`
    );

    const probed = await Promise.allSettled(
      rows.map(async (n) => {
        if (!n.api_url) return { ...n, healthy: false, probe: null };
        try {
          const r = await axios.get(`${n.api_url}/health`, { timeout: 3000 });
          return { ...n, healthy: true, probe: r.data };
        } catch {
          return { ...n, healthy: false, probe: null };
        }
      })
    );

    res.json(probed.map(r => r.status === 'fulfilled' ? r.value : { ...r.reason, healthy: false }));
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

// PUT /api/v1/ha/nodes/:nodeId/role
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

// DELETE /api/v1/ha/nodes/:nodeId
router.delete('/nodes/:nodeId', ...auth, async (req, res) => {
  if (req.params.nodeId === config.node.id) {
    return res.status(400).json({ error: 'Cannot remove the current node' });
  }
  try {
    const { rows } = await pool.query(
      'DELETE FROM nodes WHERE node_id = $1 RETURNING node_id', [req.params.nodeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Invite tokens — admin creates, new server consumes
// ---------------------------------------------------------------------------

// GET /api/v1/ha/invites
router.get('/invites', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.full_name AS created_by_name
       FROM ha_invite_tokens i
       LEFT JOIN users u ON u.id = i.created_by
       WHERE i.used_at IS NULL AND i.expires_at > NOW()
       ORDER BY i.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/ha/invites
router.post('/invites', ...auth, async (req, res) => {
  const { label, ha_role = 'standby', expires_hours = 168 } = req.body; // 7 days default
  const token = crypto.randomBytes(32).toString('hex');
  try {
    const { rows } = await pool.query(
      `INSERT INTO ha_invite_tokens (token, label, ha_role, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::interval)
       RETURNING *`,
      [token, label || null, ha_role, req.user.id, expires_hours]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/ha/invites/:id
router.delete('/invites/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM ha_invite_tokens WHERE id = $1 AND used_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invite not found or already used' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/ha/join — called by a new server to join the cluster.
// No JWT auth — uses the invite token instead.
// ---------------------------------------------------------------------------
router.post('/join', async (req, res) => {
  const { token, node_id, hostname, api_url, ha_role } = req.body;
  if (!token || !node_id || !api_url) {
    return res.status(400).json({ error: 'token, node_id, and api_url are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: inv } = await client.query(
      `SELECT * FROM ha_invite_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [token]
    );
    if (!inv.length) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Invalid, expired, or already-used invite token' });
    }
    const invite = inv[0];

    const { rows: nodeRows } = await client.query(
      `INSERT INTO nodes (node_id, hostname, ip, role, ha_role, api_url, version, last_seen, is_active)
       VALUES ($1, $2, '0.0.0.0', 'secondary', $3, $4, 'unknown', NOW(), true)
       ON CONFLICT (node_id) DO UPDATE SET
         hostname  = EXCLUDED.hostname,
         ha_role   = EXCLUDED.ha_role,
         api_url   = EXCLUDED.api_url,
         last_seen = NOW(),
         is_active = true
       RETURNING *`,
      [node_id, hostname || node_id, ha_role || invite.ha_role, api_url]
    );

    await client.query(
      `UPDATE ha_invite_tokens SET used_at = NOW(), used_by_node = $1 WHERE id = $2`,
      [nodeRows[0].id, invite.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ joined: true, node: nodeRows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ha/summary
// ---------------------------------------------------------------------------
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
