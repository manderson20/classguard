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
const { requirePermission } = require('../middleware/permissions');
const ca = require('../services/ca');
const { resolveProfileForCn } = require('../services/vpnProfiles');

const auth      = [authenticate, requirePermission('vpn_config')];
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
  const { enabled, scep_enabled, client_subnet, dns_servers } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE vpn_config SET
         enabled             = COALESCE($1, enabled),
         scep_enabled        = COALESCE($2, scep_enabled),
         client_subnet       = COALESCE($3, client_subnet),
         dns_servers         = COALESCE($4, dns_servers),
         updated_at          = NOW()
       RETURNING *`,
      [
        enabled ?? null,
        scep_enabled ?? null,
        client_subnet ?? null,
        dns_servers ?? null,
      ]
    );
    const { ca_private_key_pem, ...cfg } = rows[0];
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// VPN Profiles — each with its own subnet restriction, assignable to a user
// or group. Resolved per-session by resolveProfileForCn (services/
// vpnProfiles.js) from the connecting cert's CN. Exactly one profile is
// always is_default (migration 076 guarantees one exists at all times).
// ---------------------------------------------------------------------------

router.get('/profiles', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
         (SELECT count(*) FROM vpn_profile_assignments a WHERE a.profile_id = p.id) AS assignment_count
       FROM vpn_profiles p
       ORDER BY p.is_default DESC, p.name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/profiles', ...auth, async (req, res) => {
  const { name, restrict_to_subnets } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows: [profile] } = await pool.query(
      `INSERT INTO vpn_profiles (name, restrict_to_subnets, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [name, restrict_to_subnets || [], req.user.userId]
    );
    res.status(201).json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/profiles/:id', ...auth, async (req, res) => {
  const { name, restrict_to_subnets } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE vpn_profiles SET
         name                = COALESCE($1, name),
         restrict_to_subnets = COALESCE($2, restrict_to_subnets),
         updated_at          = NOW()
       WHERE id = $3 RETURNING *`,
      [name ?? null, restrict_to_subnets ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Profile not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /profiles/:id/make-default — atomically moves the is_default flag.
router.post('/profiles/:id/make-default', ...auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE vpn_profiles SET is_default = false WHERE is_default');
    const { rows } = await client.query(
      'UPDATE vpn_profiles SET is_default = true, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (!rows.length) throw new Error('Profile not found');
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.message === 'Profile not found' ? 404 : 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/profiles/:id', ...auth, async (req, res) => {
  try {
    const { rows: [profile] } = await pool.query('SELECT is_default FROM vpn_profiles WHERE id = $1', [req.params.id]);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    if (profile.is_default) return res.status(400).json({ error: 'Cannot delete the default profile — make another profile the default first.' });
    await pool.query('DELETE FROM vpn_profiles WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /profiles/:id/assignments — joined with user email / group name for display.
router.get('/profiles/:id/assignments', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, u.email AS user_email, u.full_name AS user_name, g.name AS group_name
       FROM vpn_profile_assignments a
       LEFT JOIN users  u ON u.id = a.user_id
       LEFT JOIN groups g ON g.id = a.group_id
       WHERE a.profile_id = $1
       ORDER BY a.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /profiles/:id/assignments — assigns a user or group to this profile.
// A user/group can only carry one direct assignment at a time (migration
// 076's partial unique indexes) -- assigning them elsewhere moves the row.
router.post('/profiles/:id/assignments', ...auth, async (req, res) => {
  const { user_id, group_id } = req.body;
  if (!user_id && !group_id) return res.status(400).json({ error: 'user_id or group_id is required' });
  if (user_id && group_id) return res.status(400).json({ error: 'Provide user_id or group_id, not both' });
  try {
    const onConflict = user_id
      ? 'ON CONFLICT (user_id) WHERE user_id IS NOT NULL'
      : 'ON CONFLICT (group_id) WHERE group_id IS NOT NULL';
    const { rows: [assignment] } = await pool.query(
      `INSERT INTO vpn_profile_assignments (profile_id, user_id, group_id, created_by)
       VALUES ($1, $2, $3, $4)
       ${onConflict}
       DO UPDATE SET profile_id = EXCLUDED.profile_id, created_by = EXCLUDED.created_by, created_at = NOW()
       RETURNING *`,
      [req.params.id, user_id || null, group_id || null, req.user.userId]
    );
    res.status(201).json(assignment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/assignments/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM vpn_profile_assignments WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ deleted: true });
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

    // Per-assigned-ip restriction list the agent applies as iptables rules
    // -- the tunnel itself stays full-reachability (local_ts = 0.0.0.0/0 in
    // swanctl.conf); this is the actual per-profile enforcement point.
    const restrictions = {};

    for (const s of sessions) {
      if (!s.cert_cn) continue;
      const profile = await resolveProfileForCn(s.cert_cn);
      if (s.assigned_ip && profile) {
        restrictions[s.assigned_ip] = profile.restrict_to_subnets || [];
      }

      const connectedAt = new Date(Date.now() - (Number(s.established_seconds) || 0) * 1000);
      const { rows: [existing] } = await pool.query(
        `SELECT id FROM vpn_clients WHERE cert_cn = $1 AND disconnected_at IS NULL`,
        [s.cert_cn]
      );
      if (existing) {
        await pool.query(
          `UPDATE vpn_clients SET assigned_ip = $1, real_ip = $2, bytes_in = $3, bytes_out = $4,
             profile_id = $5, updated_at = NOW()
           WHERE id = $6`,
          [s.assigned_ip || null, s.real_ip || null, s.bytes_in || 0, s.bytes_out || 0, profile?.id || null, existing.id]
        );
      } else {
        await pool.query(
          `INSERT INTO vpn_clients (cert_cn, assigned_ip, real_ip, bytes_in, bytes_out, profile_id, connected_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [s.cert_cn, s.assigned_ip || null, s.real_ip || null, s.bytes_in || 0, s.bytes_out || 0, profile?.id || null, connectedAt]
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

    res.json({ status: 'ok', restrictions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/vpn/sessions — admin UI: active sessions first, then recent history.
router.get('/sessions', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, p.name AS profile_name
       FROM vpn_clients c
       LEFT JOIN vpn_profiles p ON p.id = c.profile_id
       ORDER BY (c.disconnected_at IS NULL) DESC, c.connected_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
