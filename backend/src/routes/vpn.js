// Self-hosted IKEv2 VPN (StrongSwan) for staff remote access. See migration
// 052 and infrastructure/vpn/ for the container itself. This route is the
// only thing that container ever talks to: it fetches its config from
// /bootstrap on a timer and reports its current sessions to
// /internal/sessions — there's no other channel between them (no shared
// volume for config, no separate control protocol).
const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

const auth      = [authenticate, requireMinRole('admin')];
const superauth = [authenticate, requireMinRole('superadmin')];

async function getVpnConfig() {
  const { rows } = await pool.query('SELECT * FROM vpn_config LIMIT 1');
  return rows[0] || {};
}

// GET /api/v1/vpn/config
router.get('/config', ...auth, async (req, res) => {
  try {
    res.json(await getVpnConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/vpn/config — superadmin only: this includes the CA trust
// relationship (mosyle_ca_pem), same sensitivity tier as ntp's server-config.
router.put('/config', ...superauth, async (req, res) => {
  const { enabled, mosyle_ca_pem, client_subnet, dns_servers, restrict_to_subnets } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE vpn_config SET
         enabled             = COALESCE($1, enabled),
         mosyle_ca_pem       = COALESCE($2, mosyle_ca_pem),
         client_subnet       = COALESCE($3, client_subnet),
         dns_servers         = COALESCE($4, dns_servers),
         restrict_to_subnets = COALESCE($5, restrict_to_subnets),
         updated_at          = NOW()
       RETURNING *`,
      [
        enabled ?? null,
        mosyle_ca_pem ?? null,
        client_subnet ?? null,
        dns_servers ?? null,
        restrict_to_subnets ?? null,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/vpn/bootstrap — internal-secret only (vpn-agent.py, polling
// every 30s). requireMinRole passes naturally for that caller, same pattern
// as ntp.js's /internal/clients.
router.get('/bootstrap', authenticate, requireMinRole('superadmin'), async (req, res) => {
  try {
    res.json(await getVpnConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/vpn/internal/sessions — internal-secret only. vpn-agent.py
// pushes its *complete* current SA list every cycle, so this both upserts
// what's still connected and closes out (disconnected_at) anything that
// dropped out of that list since the last push — there's no separate
// "disconnect" event from StrongSwan to listen for, only this snapshot.
router.post('/internal/sessions', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { sessions } = req.body;
  if (!Array.isArray(sessions)) {
    return res.status(400).json({ error: 'sessions[] required' });
  }
  try {
    const activeCns = sessions.map(s => s.cert_cn).filter(Boolean);

    for (const s of sessions) {
      if (!s.cert_cn) continue;
      const connectedAt = new Date(Date.now() - (Number(s.established_seconds) || 0) * 1000);
      const { rows: [existing] } = await pool.query(
        `SELECT id FROM vpn_clients WHERE cert_cn = $1 AND disconnected_at IS NULL`,
        [s.cert_cn]
      );
      if (existing) {
        await pool.query(
          `UPDATE vpn_clients SET assigned_ip = $1, real_ip = $2, bytes_in = $3, bytes_out = $4, updated_at = NOW()
           WHERE id = $5`,
          [s.assigned_ip || null, s.real_ip || null, s.bytes_in || 0, s.bytes_out || 0, existing.id]
        );
      } else {
        await pool.query(
          `INSERT INTO vpn_clients (cert_cn, assigned_ip, real_ip, bytes_in, bytes_out, connected_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [s.cert_cn, s.assigned_ip || null, s.real_ip || null, s.bytes_in || 0, s.bytes_out || 0, connectedAt]
        );
      }
    }

    // Anything still marked active in our DB but absent from this push has
    // disconnected since the last report.
    if (activeCns.length) {
      await pool.query(
        `UPDATE vpn_clients SET disconnected_at = NOW(), updated_at = NOW()
         WHERE disconnected_at IS NULL AND cert_cn NOT IN (${activeCns.map((_, i) => `$${i + 1}`).join(',')})`,
        activeCns
      );
    } else {
      await pool.query(
        `UPDATE vpn_clients SET disconnected_at = NOW(), updated_at = NOW() WHERE disconnected_at IS NULL`
      );
    }

    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/vpn/sessions — admin UI: active sessions first, then recent history.
router.get('/sessions', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vpn_clients ORDER BY (disconnected_at IS NULL) DESC, connected_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
