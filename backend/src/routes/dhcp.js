const express = require('express');
const router  = express.Router();
const { pool }            = require('../db');
const { authenticate }    = require('../middleware/auth');
const { requireMinRole }  = require('../middleware/roles');
const kea = require('../services/kea');

const auth  = [authenticate, requireMinRole('admin')];

// Validate that an IP string falls within [pool_start, pool_end] using PostgreSQL
async function ipInPool(ip, poolStart, poolEnd) {
  const { rows } = await pool.query(
    `SELECT ($1::inet >= $2::inet AND $1::inet <= $3::inet) AS ok`,
    [ip, poolStart, poolEnd]
  );
  return rows[0]?.ok === true;
}

// ---------------------------------------------------------------------------
// Subnets
// ---------------------------------------------------------------------------

// GET /api/v1/dhcp/subnets
router.get('/subnets', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              COUNT(r.id)    AS reservation_count,
              ins.id         AS ipam_subnet_id,
              ins.name       AS ipam_subnet_name
       FROM dhcp_subnets s
       LEFT JOIN dhcp_reservations r ON r.subnet_id = s.id
       LEFT JOIN ipam_subnets ins    ON ins.dhcp_subnet_id = s.id
       GROUP BY s.id, ins.id, ins.name
       ORDER BY s.subnet`
    );

    // Merge Kea pool utilization stats (non-fatal if Kea is unreachable)
    let statsMap = {};
    try {
      const stats = await kea.getStats();
      for (const row of stats) {
        if (row['subnet-id']) {
          statsMap[row['subnet-id']] = {
            total: row['total-addresses'],
            used:  row['assigned-addresses'] + row['declined-addresses'],
          };
        }
      }
    } catch { /* Kea offline */ }

    const result = rows.map(s => ({
      ...s,
      kea_stats: statsMap[s.kea_subnet_id] ?? null,
    }));

    res.json(result);
  } catch (err) {
    console.error('[dhcp] GET /subnets:', err);
    res.status(500).json({ error: 'Failed to list subnets' });
  }
});

// POST /api/v1/dhcp/subnets
router.post('/subnets', ...auth, async (req, res) => {
  const { kea_subnet_id, subnet, label, pool_start, pool_end,
          gateway, dns_servers, domain_name, lease_time_seconds, notes } = req.body;

  if (!kea_subnet_id || !subnet || !pool_start || !pool_end) {
    return res.status(400).json({ error: 'kea_subnet_id, subnet, pool_start, pool_end required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO dhcp_subnets
         (kea_subnet_id, subnet, label, pool_start, pool_end, gateway,
          dns_servers, domain_name, lease_time_seconds, valid_lifetime_seconds, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11)
       RETURNING *`,
      [kea_subnet_id, subnet, label, pool_start, pool_end, gateway ?? null,
       dns_servers ?? ['127.0.0.1'], domain_name ?? null,
       lease_time_seconds ?? 86400, notes ?? null, req.user.id]
    );

    const row = rows[0];
    try { await kea.syncSubnet(row); } catch (kerr) {
      console.warn('[dhcp] Kea syncSubnet failed:', kerr.message);
    }

    res.status(201).json(row);
  } catch (err) {
    console.error('[dhcp] POST /subnets:', err);
    res.status(500).json({ error: 'Failed to create subnet' });
  }
});

// GET /api/v1/dhcp/subnets/:id
router.get('/subnets/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM dhcp_subnets WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Subnet not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[dhcp] GET /subnets/:id:', err);
    res.status(500).json({ error: 'Failed to fetch subnet' });
  }
});

// PUT /api/v1/dhcp/subnets/:id
router.put('/subnets/:id', ...auth, async (req, res) => {
  const allowed = ['label','pool_start','pool_end','gateway','dns_servers',
                   'domain_name','lease_time_seconds','valid_lifetime_seconds','notes','is_active'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No updatable fields provided' });

  const sets   = fields.map((f, i) => `"${f}" = $${i + 2}`).join(', ');
  const values = fields.map(f => req.body[f]);

  try {
    const { rows } = await pool.query(
      `UPDATE dhcp_subnets SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (!rows.length) return res.status(404).json({ error: 'Subnet not found' });

    const row = rows[0];
    try { await kea.syncSubnet(row); } catch (kerr) {
      console.warn('[dhcp] Kea syncSubnet failed:', kerr.message);
    }

    res.json(row);
  } catch (err) {
    console.error('[dhcp] PUT /subnets/:id:', err);
    res.status(500).json({ error: 'Failed to update subnet' });
  }
});

// DELETE /api/v1/dhcp/subnets/:id
router.delete('/subnets/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM dhcp_subnets WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Subnet not found' });

    const { kea_subnet_id } = rows[0];

    try { await kea.deleteSubnet(kea_subnet_id); } catch (kerr) {
      console.warn('[dhcp] Kea deleteSubnet failed:', kerr.message);
    }

    await pool.query('DELETE FROM dhcp_subnets WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[dhcp] DELETE /subnets/:id:', err);
    res.status(500).json({ error: 'Failed to delete subnet' });
  }
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

// GET /api/v1/dhcp/subnets/:id/reservations
router.get('/subnets/:id/reservations', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.full_name AS student_name, u.email AS student_email
       FROM dhcp_reservations r
       LEFT JOIN devices d ON d.id = r.device_id
       LEFT JOIN users u   ON u.id = d.user_id
       WHERE r.subnet_id = $1
       ORDER BY r.ip_address`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[dhcp] GET reservations:', err);
    res.status(500).json({ error: 'Failed to list reservations' });
  }
});

// POST /api/v1/dhcp/reservations
router.post('/reservations', ...auth, async (req, res) => {
  const { subnet_id, mac_address, ip_address, hostname, device_id, notes } = req.body;

  if (!subnet_id || !mac_address || !ip_address) {
    return res.status(400).json({ error: 'subnet_id, mac_address, ip_address required' });
  }

  const mac = mac_address.toLowerCase().replace(/[^0-9a-f]/g, match => match === ':' ? ':' : '');

  try {
    const subnetRow = await pool.query('SELECT * FROM dhcp_subnets WHERE id = $1', [subnet_id]);
    if (!subnetRow.rows.length) return res.status(404).json({ error: 'Subnet not found' });

    const subnet = subnetRow.rows[0];
    const inPool = await ipInPool(ip_address, subnet.pool_start, subnet.pool_end);
    if (!inPool) {
      return res.status(400).json({
        error: `IP ${ip_address} is not within pool ${subnet.pool_start}–${subnet.pool_end}`,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO dhcp_reservations
         (subnet_id, mac_address, ip_address, hostname, device_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [subnet_id, mac, ip_address, hostname ?? null, device_id ?? null, notes ?? null, req.user.id]
    );

    const row = rows[0];
    try {
      await kea.syncReservation({ ...row, kea_subnet_id: subnet.kea_subnet_id });
    } catch (kerr) {
      console.warn('[dhcp] Kea syncReservation failed:', kerr.message);
    }

    res.status(201).json(row);
  } catch (err) {
    console.error('[dhcp] POST /reservations:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Reservation already exists for that MAC or IP in this subnet' });
    res.status(500).json({ error: 'Failed to create reservation' });
  }
});

// PUT /api/v1/dhcp/reservations/:id
router.put('/reservations/:id', ...auth, async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      `SELECT r.*, s.kea_subnet_id
       FROM dhcp_reservations r
       JOIN dhcp_subnets s ON s.id = r.subnet_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Reservation not found' });

    const old = existing[0];

    // Delete old reservation from Kea before updating
    try {
      await kea.deleteReservation(old.mac_address, old.kea_subnet_id);
    } catch (kerr) {
      console.warn('[dhcp] Kea deleteReservation (pre-update) failed:', kerr.message);
    }

    const { mac_address, ip_address, hostname, notes } = req.body;

    if (ip_address) {
      const inPool = await ipInPool(ip_address, old.pool_start, old.pool_end);
      if (!inPool) {
        return res.status(400).json({ error: `IP ${ip_address} is not within the subnet pool` });
      }
    }

    const mac = mac_address ? mac_address.toLowerCase() : old.mac_address;

    const { rows } = await pool.query(
      `UPDATE dhcp_reservations SET
         mac_address = $2,
         ip_address  = $3,
         hostname    = $4,
         notes       = $5,
         updated_at  = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, mac, ip_address ?? old.ip_address,
       hostname ?? old.hostname, notes ?? old.notes]
    );

    const updated = rows[0];
    try {
      await kea.syncReservation({ ...updated, kea_subnet_id: old.kea_subnet_id });
    } catch (kerr) {
      console.warn('[dhcp] Kea syncReservation (post-update) failed:', kerr.message);
    }

    res.json(updated);
  } catch (err) {
    console.error('[dhcp] PUT /reservations/:id:', err);
    res.status(500).json({ error: 'Failed to update reservation' });
  }
});

// DELETE /api/v1/dhcp/reservations/:id
router.delete('/reservations/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.mac_address, s.kea_subnet_id
       FROM dhcp_reservations r
       JOIN dhcp_subnets s ON s.id = r.subnet_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });

    const { mac_address, kea_subnet_id } = rows[0];
    try { await kea.deleteReservation(mac_address, kea_subnet_id); } catch (kerr) {
      console.warn('[dhcp] Kea deleteReservation failed:', kerr.message);
    }

    await pool.query('DELETE FROM dhcp_reservations WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[dhcp] DELETE /reservations/:id:', err);
    res.status(500).json({ error: 'Failed to delete reservation' });
  }
});

// ---------------------------------------------------------------------------
// Leases (proxied from Kea, joined with devices table)
// ---------------------------------------------------------------------------

// GET /api/v1/dhcp/leases
router.get('/leases', ...auth, async (req, res) => {
  try {
    const leases = await kea.getLeases();

    // Join MAC addresses with the devices table for student identity
    const macs = leases.map(l => l['hw-addr']).filter(Boolean);
    let deviceMap = {};
    if (macs.length) {
      const { rows } = await pool.query(
        `SELECT d.identifier AS mac, u.full_name, u.email
         FROM devices d
         LEFT JOIN users u ON u.id = d.user_id
         WHERE d.identifier = ANY($1::text[])`,
        [macs]
      );
      deviceMap = Object.fromEntries(rows.map(r => [r.mac, r]));
    }

    const enriched = leases.map(l => ({
      ...l,
      student: deviceMap[l['hw-addr']] ?? null,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('[dhcp] GET /leases:', err);
    res.status(502).json({ error: `Kea unreachable: ${err.message}` });
  }
});

// GET /api/v1/dhcp/leases/:ip
router.get('/leases/:ip', ...auth, async (req, res) => {
  try {
    const lease = await kea.getLease(req.params.ip);
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    res.json(lease);
  } catch (err) {
    console.error('[dhcp] GET /leases/:ip:', err);
    res.status(502).json({ error: err.message });
  }
});

// DELETE /api/v1/dhcp/leases/:ip  (force-expire)
router.delete('/leases/:ip', ...auth, async (req, res) => {
  try {
    await kea.deleteLease(req.params.ip);
    res.json({ expired: true });
  } catch (err) {
    console.error('[dhcp] DELETE /leases/:ip:', err);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

// GET /api/v1/dhcp/stats
router.get('/stats', ...auth, async (req, res) => {
  try {
    const stats = await kea.getStats();
    res.json(stats);
  } catch (err) {
    console.error('[dhcp] GET /stats:', err);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HA Status
// ---------------------------------------------------------------------------

// GET /api/v1/dhcp/ha-status
router.get('/ha-status', ...auth, async (req, res) => {
  try {
    const status = await kea.getHAStatus();
    res.json(status);
  } catch (err) {
    console.error('[dhcp] GET /ha-status:', err);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sync all subnets + reservations from DB → Kea
// ---------------------------------------------------------------------------

// POST /api/v1/dhcp/sync-kea
router.post('/sync-kea', ...auth, async (req, res) => {
  res.json({ status: 'started', message: 'Kea sync initiated' });

  (async () => {
    try {
      const { rows: subnets } = await pool.query('SELECT * FROM dhcp_subnets WHERE is_active = true');
      const { rows: globalOpts } = await pool.query(
        `SELECT * FROM dhcp_options WHERE scope='global' AND is_active=true`
      );

      for (const subnet of subnets) {
        const { rows: subnetOpts } = await pool.query(
          `SELECT * FROM dhcp_options WHERE scope='subnet' AND dhcp_subnet_id=$1 AND is_active=true`,
          [subnet.id]
        );
        // Subnet-specific options override globals for the same option_name
        const subnetNames = new Set(subnetOpts.map(o => o.option_name));
        const merged = [...subnetOpts, ...globalOpts.filter(o => !subnetNames.has(o.option_name))];
        await kea.syncSubnet(subnet, merged).catch(e => console.warn('[dhcp] syncSubnet:', e.message));
      }

      const { rows: reservations } = await pool.query(
        `SELECT r.*, s.kea_subnet_id
         FROM dhcp_reservations r
         JOIN dhcp_subnets s ON s.id = r.subnet_id`
      );
      for (const r of reservations) {
        await kea.syncReservation(r).catch(e => console.warn('[dhcp] syncReservation:', e.message));
      }

      console.log(`[dhcp] Kea sync complete — ${subnets.length} subnets, ${reservations.length} reservations`);
    } catch (err) {
      console.error('[dhcp] sync-kea failed:', err);
    }
  })();
});

// ---------------------------------------------------------------------------
// DHCP Options — global
// ---------------------------------------------------------------------------

// GET /api/v1/dhcp/options
router.get('/options', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM dhcp_options WHERE scope='global' ORDER BY option_name`
  );
  res.json(rows);
});

// POST /api/v1/dhcp/options
router.post('/options', ...auth, async (req, res) => {
  const { option_name, option_label, option_data, option_code } = req.body;
  if (!option_name || !option_data) return res.status(400).json({ error: 'option_name and option_data required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO dhcp_options (scope, option_code, option_name, option_label, option_data, created_by)
       VALUES ('global',$1,$2,$3,$4,$5) RETURNING *`,
      [option_code || null, option_name, option_label || null, option_data, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Option already exists' });
    throw err;
  }
});

// PUT /api/v1/dhcp/options/:id
router.put('/options/:id', ...auth, async (req, res) => {
  const { option_data, option_label, is_active } = req.body;
  const { rows } = await pool.query(
    `UPDATE dhcp_options
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

// DELETE /api/v1/dhcp/options/:id
router.delete('/options/:id', ...auth, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM dhcp_options WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Option not found' });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// DHCP Options — per-scope
// ---------------------------------------------------------------------------

// GET /api/v1/dhcp/subnets/:id/options
router.get('/subnets/:id/options', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM dhcp_options WHERE scope='subnet' AND dhcp_subnet_id=$1 ORDER BY option_name`,
    [req.params.id]
  );
  res.json(rows);
});

// POST /api/v1/dhcp/subnets/:id/options
router.post('/subnets/:id/options', ...auth, async (req, res) => {
  const { option_name, option_label, option_data, option_code } = req.body;
  if (!option_name || !option_data) return res.status(400).json({ error: 'option_name and option_data required' });
  const { rows } = await pool.query(
    `INSERT INTO dhcp_options (scope, dhcp_subnet_id, option_code, option_name, option_label, option_data, created_by)
     VALUES ('subnet',$1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.params.id, option_code || null, option_name, option_label || null, option_data, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// PUT /api/v1/dhcp/subnets/:id/options/:optId
router.put('/subnets/:id/options/:optId', ...auth, async (req, res) => {
  const { option_data, option_label, is_active } = req.body;
  const { rows } = await pool.query(
    `UPDATE dhcp_options
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

// DELETE /api/v1/dhcp/subnets/:id/options/:optId
router.delete('/subnets/:id/options/:optId', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM dhcp_options WHERE id=$1 AND dhcp_subnet_id=$2 RETURNING id',
    [req.params.optId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Option not found' });
  res.json({ deleted: true });
});

module.exports = router;
