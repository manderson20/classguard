const express = require('express');
const router  = express.Router();
const { pool }              = require('../db');
const { authenticate }      = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const kea           = require('../services/kea');
const dhcpKeaSyncV6 = require('../services/dhcpKeaSyncV6');

const auth = [authenticate, requirePermission('dhcp')];

// ---------------------------------------------------------------------------
// Subnets
// ---------------------------------------------------------------------------

// GET /api/v1/dhcpv6/subnets
router.get('/subnets', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              COUNT(r.id) AS reservation_count
       FROM dhcp_subnets_v6 s
       LEFT JOIN dhcp_reservations_v6 r ON r.subnet_id = s.id
       GROUP BY s.id
       ORDER BY s.subnet`
    );

    let statsMap = {};
    try {
      const stats = await kea.getStats6();
      for (const row of stats) {
        if (row['subnet-id']) {
          statsMap[row['subnet-id']] = {
            total: row['total-nas'],
            used:  (row['assigned-nas'] ?? 0) + (row['declined-nas'] ?? 0),
          };
        }
      }
    } catch { /* Kea offline */ }

    res.json(rows.map(s => ({ ...s, kea_stats: statsMap[s.kea_subnet_id] ?? null })));
  } catch (err) {
    console.error('[dhcpv6] GET /subnets:', err);
    res.status(500).json({ error: 'Failed to list subnets' });
  }
});

// POST /api/v1/dhcpv6/subnets
router.post('/subnets', ...auth, async (req, res) => {
  const { kea_subnet_id, subnet, label, pool_start, pool_end,
          dns_servers, domain_name, preferred_lifetime_seconds,
          valid_lifetime_seconds, notes } = req.body;

  if (!kea_subnet_id || !subnet || !pool_start || !pool_end) {
    return res.status(400).json({ error: 'kea_subnet_id, subnet, pool_start, pool_end required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO dhcp_subnets_v6
         (kea_subnet_id, subnet, label, pool_start, pool_end, dns_servers,
          domain_name, preferred_lifetime_seconds, valid_lifetime_seconds, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [kea_subnet_id, subnet, label || null, pool_start, pool_end,
       dns_servers ?? null, domain_name ?? null,
       preferred_lifetime_seconds ?? 43200, valid_lifetime_seconds ?? 86400,
       notes ?? null, req.user.id]
    );

    try { await dhcpKeaSyncV6.run(); } catch (kerr) {
      console.warn('[dhcpv6] Kea sync failed:', kerr.message);
    }
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[dhcpv6] POST /subnets:', err);
    res.status(500).json({ error: 'Failed to create subnet' });
  }
});

// GET /api/v1/dhcpv6/subnets/:id
router.get('/subnets/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM dhcp_subnets_v6 WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Subnet not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[dhcpv6] GET /subnets/:id:', err);
    res.status(500).json({ error: 'Failed to fetch subnet' });
  }
});

// PUT /api/v1/dhcpv6/subnets/:id
router.put('/subnets/:id', ...auth, async (req, res) => {
  const allowed = ['label','pool_start','pool_end','dns_servers','domain_name',
                   'preferred_lifetime_seconds','valid_lifetime_seconds','notes','is_active'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No updatable fields provided' });

  const sets   = fields.map((f, i) => `"${f}" = $${i + 2}`).join(', ');
  const values = fields.map(f => req.body[f]);

  try {
    const { rows } = await pool.query(
      `UPDATE dhcp_subnets_v6 SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (!rows.length) return res.status(404).json({ error: 'Subnet not found' });

    try { await dhcpKeaSyncV6.run(); } catch (kerr) {
      console.warn('[dhcpv6] Kea sync failed:', kerr.message);
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[dhcpv6] PUT /subnets/:id:', err);
    res.status(500).json({ error: 'Failed to update subnet' });
  }
});

// DELETE /api/v1/dhcpv6/subnets/:id
router.delete('/subnets/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM dhcp_subnets_v6 WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Subnet not found' });

    await pool.query('DELETE FROM dhcp_subnets_v6 WHERE id = $1', [req.params.id]);
    try { await dhcpKeaSyncV6.run(); } catch (kerr) {
      console.warn('[dhcpv6] Kea sync failed:', kerr.message);
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('[dhcpv6] DELETE /subnets/:id:', err);
    res.status(500).json({ error: 'Failed to delete subnet' });
  }
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

// GET /api/v1/dhcpv6/subnets/:id/reservations
router.get('/subnets/:id/reservations', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.full_name AS student_name, u.email AS student_email
       FROM dhcp_reservations_v6 r
       LEFT JOIN devices d ON d.id = r.device_id
       LEFT JOIN users u   ON u.id = d.current_user_id
       WHERE r.subnet_id = $1
       ORDER BY r.ip_address`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[dhcpv6] GET reservations:', err);
    res.status(500).json({ error: 'Failed to list reservations' });
  }
});

// POST /api/v1/dhcpv6/reservations
router.post('/reservations', ...auth, async (req, res) => {
  const { subnet_id, duid, ip_address, hostname, device_id, notes } = req.body;

  if (!subnet_id || !duid || !ip_address) {
    return res.status(400).json({ error: 'subnet_id, duid, ip_address required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO dhcp_reservations_v6
         (subnet_id, duid, ip_address, hostname, device_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [subnet_id, duid.toLowerCase(), ip_address,
       hostname ?? null, device_id ?? null, notes ?? null, req.user.id]
    );

    try { await dhcpKeaSyncV6.run(); } catch (kerr) {
      console.warn('[dhcpv6] Kea sync failed:', kerr.message);
    }
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'DUID or IP already reserved' });
    console.error('[dhcpv6] POST /reservations:', err);
    res.status(500).json({ error: 'Failed to create reservation' });
  }
});

// DELETE /api/v1/dhcpv6/reservations/:id
router.delete('/reservations/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM dhcp_reservations_v6 WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });

    try { await dhcpKeaSyncV6.run(); } catch (kerr) {
      console.warn('[dhcpv6] Kea sync failed:', kerr.message);
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('[dhcpv6] DELETE /reservations/:id:', err);
    res.status(500).json({ error: 'Failed to delete reservation' });
  }
});

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

// GET /api/v1/dhcpv6/leases
router.get('/leases', ...auth, async (req, res) => {
  try {
    const leases = await kea.getLeases6();
    res.json(leases);
  } catch (err) {
    console.error('[dhcpv6] GET /leases:', err);
    res.status(502).json({ error: `Kea unreachable: ${err.message}` });
  }
});

// DELETE /api/v1/dhcpv6/leases/:ip  (force-expire)
router.delete('/leases/:ip', ...auth, async (req, res) => {
  try {
    await kea.deleteLease6(req.params.ip);
    res.json({ expired: true });
  } catch (err) {
    console.error('[dhcpv6] DELETE /leases/:ip:', err);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

// GET /api/v1/dhcpv6/stats
router.get('/stats', ...auth, async (req, res) => {
  try {
    const stats = await kea.getStats6();
    res.json(stats);
  } catch (err) {
    console.error('[dhcpv6] GET /stats:', err);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sync DB → Kea
// ---------------------------------------------------------------------------

// POST /api/v1/dhcpv6/sync-kea
router.post('/sync-kea', ...auth, async (req, res) => {
  res.json({ status: 'started', message: 'Kea DHCPv6 sync initiated' });

  dhcpKeaSyncV6.run()
    .then(({ subnets, reservations }) =>
      console.log(`[dhcpv6] Kea sync complete — ${subnets} subnets, ${reservations} reservations`))
    .catch(err => console.error('[dhcpv6] sync-kea failed:', err));
});

// ---------------------------------------------------------------------------
// Options — global
// ---------------------------------------------------------------------------

// GET /api/v1/dhcpv6/options
router.get('/options', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM dhcp_options_v6 WHERE scope='global' ORDER BY option_name`
  );
  res.json(rows);
});

// POST /api/v1/dhcpv6/options
router.post('/options', ...auth, async (req, res) => {
  const { option_name, option_label, option_data, option_code } = req.body;
  if (!option_name || !option_data) return res.status(400).json({ error: 'option_name and option_data required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO dhcp_options_v6 (scope, option_code, option_name, option_label, option_data, created_by)
       VALUES ('global',$1,$2,$3,$4,$5) RETURNING *`,
      [option_code || null, option_name, option_label || null, option_data, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Option already exists' });
    throw err;
  }
});

// PUT /api/v1/dhcpv6/options/:id
router.put('/options/:id', ...auth, async (req, res) => {
  const { option_data, option_label, is_active } = req.body;
  const { rows } = await pool.query(
    `UPDATE dhcp_options_v6
     SET option_data  = COALESCE($2, option_data),
         option_label = COALESCE($3, option_label),
         is_active    = COALESCE($4, is_active),
         updated_at   = NOW()
     WHERE id = $1 RETURNING *`,
    [req.params.id, option_data || null, option_label || null, is_active ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Option not found' });
  res.json(rows[0]);
});

// DELETE /api/v1/dhcpv6/options/:id
router.delete('/options/:id', ...auth, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM dhcp_options_v6 WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Option not found' });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Options — per-subnet
// ---------------------------------------------------------------------------

// GET /api/v1/dhcpv6/subnets/:id/options
router.get('/subnets/:id/options', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM dhcp_options_v6 WHERE scope='subnet' AND dhcp_subnet_id=$1 ORDER BY option_name`,
    [req.params.id]
  );
  res.json(rows);
});

// POST /api/v1/dhcpv6/subnets/:id/options
router.post('/subnets/:id/options', ...auth, async (req, res) => {
  const { option_name, option_label, option_data, option_code } = req.body;
  if (!option_name || !option_data) return res.status(400).json({ error: 'option_name and option_data required' });
  const { rows } = await pool.query(
    `INSERT INTO dhcp_options_v6 (scope, dhcp_subnet_id, option_code, option_name, option_label, option_data, created_by)
     VALUES ('subnet',$1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.params.id, option_code || null, option_name, option_label || null, option_data, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// PUT /api/v1/dhcpv6/subnets/:id/options/:optId
router.put('/subnets/:id/options/:optId', ...auth, async (req, res) => {
  const { option_data, option_label, is_active } = req.body;
  const { rows } = await pool.query(
    `UPDATE dhcp_options_v6
     SET option_data  = COALESCE($3, option_data),
         option_label = COALESCE($4, option_label),
         is_active    = COALESCE($5, is_active),
         updated_at   = NOW()
     WHERE id=$1 AND dhcp_subnet_id=$2 RETURNING *`,
    [req.params.optId, req.params.id, option_data || null, option_label || null, is_active ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Option not found' });
  res.json(rows[0]);
});

// DELETE /api/v1/dhcpv6/subnets/:id/options/:optId
router.delete('/subnets/:id/options/:optId', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM dhcp_options_v6 WHERE id=$1 AND dhcp_subnet_id=$2 RETURNING id',
    [req.params.optId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Option not found' });
  res.json({ deleted: true });
});

module.exports = router;
