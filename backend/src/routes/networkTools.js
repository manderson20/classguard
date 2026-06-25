// Network diagnostics -- ping, traceroute, and "what public IP is our own
// outbound traffic using." Same permission tier as Network Infra: this is
// the same conceptual "network operations" surface, not a separate concern.
const { Router } = require('express');
const axios = require('axios');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermissionIfAdmin } = require('../middleware/permissions');
const networkTools = require('../services/networkTools');

const router = Router();
const auth = [authenticate, requireMinRole('admin'), requirePermissionIfAdmin('network')];

router.post('/ping', ...auth, async (req, res) => {
  try {
    const result = await networkTools.ping(req.body.host, req.body.count);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/traceroute', ...auth, async (req, res) => {
  try {
    const result = await networkTools.traceroute(req.body.host);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// This node's own outbound public IP.
router.get('/public-ip', ...auth, async (req, res) => {
  try {
    const ip = await networkTools.getPublicIp();
    res.json({ ip });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the public-IP lookup service' });
  }
});

// Every active HA node's outbound public IP, in one call -- same
// Promise.allSettled cross-node probe pattern as GET /ha/nodes, since two
// nodes behind different upstream NAT can legitimately show different
// addresses, and that's exactly the thing worth surfacing here.
router.get('/public-ip/all', ...auth, async (req, res) => {
  const { rows } = await pool.query(`SELECT node_id, api_url FROM nodes WHERE is_active = true`);
  const probed = await Promise.allSettled(
    rows.map(async (n) => {
      if (!n.api_url) return { node_id: n.node_id, ip: null, error: 'no api_url configured' };
      try {
        const r = await axios.get(`${n.api_url}/api/v1/network-tools/public-ip`, {
          timeout: 6000,
          headers: { Authorization: req.headers.authorization },
        });
        return { node_id: n.node_id, ip: r.data.ip };
      } catch (err) {
        return { node_id: n.node_id, ip: null, error: err.message };
      }
    })
  );
  res.json(probed.map(r => r.status === 'fulfilled' ? r.value : { ip: null, error: 'probe failed' }));
});

module.exports = router;
