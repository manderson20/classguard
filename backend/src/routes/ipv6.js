// Optional Hurricane Electric IPv6 tunnel — see migration 054 and
// services/ipv6Tunnel.js. Off by default; only relevant to districts whose
// ISP doesn't offer native IPv6.
const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const ipv6Tunnel = require('../services/ipv6Tunnel');

const auth      = [authenticate, requireMinRole('admin')];
const superauth = [authenticate, requireMinRole('superadmin')];

// GET /api/v1/ipv6/config
router.get('/config', ...auth, async (req, res) => {
  try {
    res.json(await ipv6Tunnel.getTunnelConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/ipv6/config — superadmin only, same sensitivity tier as the
// VPN/NTP server configs (this is real network config, not a UI preference).
router.put('/config', ...superauth, async (req, res) => {
  const { enabled, he_user_id, he_tunnel_id, he_server_ipv4, he_client_ipv4, routed_prefix, local_ipv6 } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE ipv6_tunnel_config SET
         enabled        = COALESCE($1, enabled),
         he_user_id     = COALESCE($2, he_user_id),
         he_tunnel_id   = COALESCE($3, he_tunnel_id),
         he_server_ipv4 = COALESCE($4::inet, he_server_ipv4),
         he_client_ipv4 = COALESCE($5::inet, he_client_ipv4),
         routed_prefix  = COALESCE($6::cidr, routed_prefix),
         local_ipv6     = COALESCE($7::inet, local_ipv6),
         updated_at     = NOW()
       RETURNING *`,
      [
        enabled ?? null, he_user_id ?? null, he_tunnel_id ?? null,
        he_server_ipv4 ?? null, he_client_ipv4 ?? null,
        routed_prefix ?? null, local_ipv6 ?? null,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ipv6/bundle — setup/install/health-report scripts for the node
// terminating the tunnel, same shape as ntp.js's /server-bundle.
router.get('/bundle', ...superauth, async (req, res) => {
  try {
    res.json(await ipv6Tunnel.buildBundle());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/ipv6/internal/status — internal-secret only (ipv6-health-report.sh,
// cron every 5 min). requireMinRole passes naturally for that caller, same
// pattern as ntp.js's /internal/clients.
router.post('/internal/status', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  try {
    await pool.query(
      `UPDATE ipv6_tunnel_config SET last_status = $1, last_seen_at = NOW()`,
      [status]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
