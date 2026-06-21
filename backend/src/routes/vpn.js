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
const ca = require('../services/ca');

const auth      = [authenticate, requireMinRole('admin')];
const superauth = [authenticate, requireMinRole('superadmin')];

async function getVpnConfig() {
  const { rows } = await pool.query('SELECT * FROM vpn_config LIMIT 1');
  return rows[0] || {};
}

// GET /api/v1/vpn/config — never returns ca_private_key_pem; the admin UI
// only needs the public cert (to show fingerprint/expiry and offer a
// download) plus the challenge to copy into Mosyle's SCEP profile.
router.get('/config', ...auth, async (req, res) => {
  try {
    const { ca_private_key_pem, ...cfg } = await getVpnConfig();
    if (cfg.ca_cert_pem) cfg.ca_info = ca.certInfo(cfg.ca_cert_pem);
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/vpn/config — superadmin only. CA material itself is never set
// here — that's POST /generate-ca only — this is for the VPN's own network
// config plus toggling the SCEP service on/off once a CA exists.
router.put('/config', ...superauth, async (req, res) => {
  const { enabled, scep_enabled, client_subnet, dns_servers, restrict_to_subnets } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE vpn_config SET
         enabled             = COALESCE($1, enabled),
         scep_enabled        = COALESCE($2, scep_enabled),
         client_subnet       = COALESCE($3, client_subnet),
         dns_servers         = COALESCE($4, dns_servers),
         restrict_to_subnets = COALESCE($5, restrict_to_subnets),
         updated_at          = NOW()
       RETURNING *`,
      [
        enabled ?? null,
        scep_enabled ?? null,
        client_subnet ?? null,
        dns_servers ?? null,
        restrict_to_subnets ?? null,
      ]
    );
    const { ca_private_key_pem, ...cfg } = rows[0];
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/vpn/generate-ca — superadmin only. One-time (or deliberate
// rotation): generates ClassGuard's own CA + a SCEP challenge secret and
// overwrites whatever was there before. Rotating invalidates every
// previously issued client cert, by design — there's no selective
// revocation in this build (see migration 053's comment), so this is the
// only "revoke everything" lever that exists.
router.post('/generate-ca', ...superauth, async (req, res) => {
  try {
    const { ca_cert_pem, ca_private_key_pem } = ca.generateCa();
    const scep_challenge = ca.generateChallenge();
    await pool.query(
      `UPDATE vpn_config SET ca_cert_pem = $1, ca_private_key_pem = $2, scep_challenge = $3, updated_at = NOW()`,
      [ca_cert_pem, ca_private_key_pem, scep_challenge]
    );
    res.json({ ca_cert_pem, scep_challenge, info: ca.certInfo(ca_cert_pem) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/vpn/bootstrap — internal-secret only (vpn-agent.py, polling
// every 30s). requireMinRole passes naturally for that caller, same pattern
// as ntp.js's /internal/clients. Still excludes the CA private key — the
// VPN server only ever needs to trust the CA's public cert, never sign
// anything with it.
router.get('/bootstrap', authenticate, requireMinRole('superadmin'), async (req, res) => {
  try {
    const { ca_private_key_pem, ...cfg } = await getVpnConfig();
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/vpn/scep-bootstrap — internal-secret only. Unlike /bootstrap
// above, the SCEP server legitimately needs the private key — it's the one
// thing in this whole system that actually signs certs with it.
router.get('/scep-bootstrap', authenticate, requireMinRole('superadmin'), async (req, res) => {
  try {
    const cfg = await getVpnConfig();
    res.json({
      enabled:            cfg.scep_enabled,
      ca_cert_pem:        cfg.ca_cert_pem,
      ca_private_key_pem: cfg.ca_private_key_pem,
      scep_challenge:     cfg.scep_challenge,
    });
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
