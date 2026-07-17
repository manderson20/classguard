const express = require('express');
const router  = express.Router();
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getAdapter, VENDORS } = require('../services/network');

const auth = [authenticate, requirePermission('network')];

// ---------------------------------------------------------------------------
// Network controllers (CRUD)
// ---------------------------------------------------------------------------

// GET /api/v1/network/controllers
router.get('/controllers', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, vendor, base_url, site_id, is_active, last_sync, last_error, created_at,
              (SELECT COUNT(*) FROM network_clients nc WHERE nc.controller_id = n.id) AS client_count
       FROM network_controllers n
       ORDER BY created_at`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/v1/network/controllers
router.post('/controllers', ...auth, async (req, res) => {
  const { name, vendor, base_url, site_id, username, password, api_key, extra_config } = req.body;
  if (!name || !vendor) return res.status(400).json({ error: 'name and vendor required' });
  if (!VENDORS.includes(vendor)) return res.status(400).json({ error: `vendor must be one of: ${VENDORS.join(', ')}` });

  try {
    const { rows } = await pool.query(
      `INSERT INTO network_controllers (name, vendor, base_url, site_id, username, password, api_key, extra_config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, vendor, base_url || null, site_id || null, username || null,
       password || null, api_key || null, extra_config ? JSON.stringify(extra_config) : '{}']
    );
    // Mask secrets before returning
    const row = rows[0];
    delete row.password; delete row.api_key;
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/v1/network/controllers/:id
router.put('/controllers/:id', ...auth, async (req, res) => {
  const { name, base_url, site_id, username, password, api_key, extra_config, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE network_controllers SET
         name         = COALESCE($1, name),
         base_url     = COALESCE($2, base_url),
         site_id      = COALESCE($3, site_id),
         username     = COALESCE($4, username),
         password     = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE password END,
         api_key      = CASE WHEN $6::text IS NOT NULL THEN $6 ELSE api_key  END,
         extra_config = COALESCE($7::jsonb, extra_config),
         is_active    = COALESCE($8, is_active)
       WHERE id = $9 RETURNING id, name, vendor, base_url, site_id, is_active, last_sync`,
      [name, base_url, site_id, username, password || null, api_key || null,
       extra_config ? JSON.stringify(extra_config) : null, is_active ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Controller not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/v1/network/controllers/:id
router.delete('/controllers/:id', ...auth, async (req, res) => {
  await pool.query('DELETE FROM network_controllers WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

// POST /api/v1/network/controllers/:id/test  — test connection without saving
router.post('/controllers/:id/test', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM network_controllers WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Controller not found' });
    const adapter = getAdapter(rows[0].vendor);
    const result  = await adapter.testConnection(rows[0]);
    res.json(result);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// GET /api/v1/network/controllers/:id/networks — live list of the
// controller's configured networks/VLANs (name, subnet, DHCP). Fetched on
// demand rather than synced: it backs an informational popover and should
// always show the controller's current config.
router.get('/controllers/:id/networks', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM network_controllers WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Controller not found' });
    const adapter = getAdapter(rows[0].vendor);
    if (!adapter.fetchNetworks) {
      return res.status(400).json({ error: `Network listing is not supported for ${rows[0].vendor} controllers` });
    }
    res.json(await adapter.fetchNetworks(rows[0]));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// POST /api/v1/network/controllers/:id/sync  — sync clients from one controller
router.post('/controllers/:id/sync', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  syncController(req.params.id).catch(err =>
    console.error(`[network] sync controller ${req.params.id}:`, err.message)
  );
});

// POST /api/v1/network/sync-all  — sync all active controllers
router.post('/sync-all', ...auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM network_controllers WHERE is_active = true');
  res.json({ status: 'started', count: rows.length });
  for (const { id } of rows) {
    syncController(id).catch(err => console.error(`[network] sync ${id}:`, err.message));
  }
});

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

// GET /api/v1/network/clients?controller_id=&search=&ap=&vlan=&type=wired|wireless&page=&limit=
router.get('/clients', ...auth, async (req, res) => {
  const { controller_id, search, ap, vlan, type, page = 1, limit = 100 } = req.query;
  const conditions = [];
  const values     = [];

  if (controller_id) { conditions.push(`c.controller_id = $${values.length+1}`); values.push(controller_id); }
  if (ap)            { conditions.push(`c.ap_name ILIKE $${values.length+1}`);    values.push(`%${ap}%`); }
  if (vlan)          { conditions.push(`c.vlan = $${values.length+1}`);           values.push(vlan); }
  if (type)          { conditions.push(`c.connection_type = $${values.length+1}`);values.push(type); }
  if (search) {
    conditions.push(`(c.mac::text ILIKE $${values.length+1} OR c.hostname ILIKE $${values.length+1} OR c.ip_address::text ILIKE $${values.length+1})`);
    values.push(`%${search}%`);
  }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  try {
    const [{ rows }, { rows: total }] = await Promise.all([
      pool.query(
        `SELECT c.*, n.name AS controller_name, n.vendor
         FROM network_clients c
         JOIN network_controllers n ON n.id = c.controller_id
         ${where}
         ORDER BY c.last_seen DESC NULLS LAST
         LIMIT $${values.length+1} OFFSET $${values.length+2}`,
        [...values, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM network_clients c ${where}`, values),
    ]);
    res.json({ clients: rows, total: parseInt(total[0].count, 10), page: parseInt(page, 10) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/v1/network/clients/lookup/:mac  — find a specific device by MAC
// Returns client record, plus matching DHCP reservation, integration device, and DNS logs
router.get('/clients/lookup/:mac', ...auth, async (req, res) => {
  const mac = req.params.mac.toLowerCase().replace(/[^0-9a-f]/g, ':');
  try {
    const [{ rows: clients }, { rows: dhcp }] = await Promise.all([
      pool.query(
        `SELECT c.*, n.name AS controller_name, n.vendor
         FROM network_clients c JOIN network_controllers n ON n.id = c.controller_id
         WHERE c.mac = $1 ORDER BY c.last_seen DESC LIMIT 5`,
        [mac]
      ),
      pool.query(
        `SELECT r.*, s.label AS subnet_name, s.subnet
         FROM dhcp_reservations r JOIN dhcp_subnets s ON s.id = r.subnet_id
         WHERE r.mac_address = $1`,
        [mac]
      ),
    ]);

    // dhcp_reservations has no link to a user/student - dns_logs is keyed by
    // source_ip, so resolve through the device's current observed IP (live
    // controller data first, since most clients are dynamic and never get a
    // reservation at all; the static reservation IP is the fallback).
    const ip = clients[0]?.ip_address || dhcp[0]?.ip_address || null;

    const [{ rows: device }, { rows: dns }] = await Promise.all([
      pool.query(
        `SELECT * FROM integration_devices WHERE $1 = ANY(mac_addresses) LIMIT 1`,
        [mac]
      ),
      ip
        ? pool.query(
            `SELECT domain, action, block_reason, queried_at
             FROM dns_logs WHERE source_ip = $1::inet AND queried_at > NOW() - INTERVAL '1 hour'
             ORDER BY queried_at DESC LIMIT 50`,
            [ip]
          )
        : Promise.resolve({ rows: [] }),
    ]);
    res.json({ network: clients[0] || null, dhcp: dhcp[0] || null, device: device[0] || null, recent_dns: dns });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/v1/network/aps  — list all known APs with client counts
router.get('/aps', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.controller_id, n.name AS controller_name, n.vendor,
        c.ap_name,
        COUNT(*) FILTER (WHERE c.status = 'online') AS online_clients,
        COUNT(*) AS total_clients,
        AVG(c.rssi) AS avg_rssi,
        MAX(c.last_seen) AS last_activity
      FROM network_clients c
      JOIN network_controllers n ON n.id = c.controller_id
      WHERE c.ap_name IS NOT NULL
      GROUP BY c.controller_id, n.name, n.vendor, c.ap_name
      ORDER BY online_clients DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// DNS conditional forwarding zones
// ---------------------------------------------------------------------------

router.get('/dns-forward-zones', ...auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM dns_forward_zones ORDER BY domain');
  res.json(rows);
});

router.post('/dns-forward-zones', ...auth, async (req, res) => {
  const { domain, forward_to, description } = req.body;
  if (!domain || !forward_to) return res.status(400).json({ error: 'domain and forward_to required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO dns_forward_zones (domain, forward_to, description)
       VALUES ($1,$2,$3) RETURNING *`,
      [domain.toLowerCase(), forward_to, description || null]
    );
    // Invalidate DNS engine cache so it picks up the new zone
    const redis = require('../redis');
    await redis.del('classguard:forward-zones').catch(() => {});
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/dns-forward-zones/:id', ...auth, async (req, res) => {
  const { forward_to, description, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE dns_forward_zones SET
         forward_to  = COALESCE($1::inet, forward_to),
         description = COALESCE($2, description),
         is_active   = COALESCE($3, is_active)
       WHERE id = $4 RETURNING *`,
      [forward_to || null, description || null, is_active ?? null, req.params.id]
    );
    const redis = require('../redis');
    await redis.del('classguard:forward-zones').catch(() => {});
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/dns-forward-zones/:id', ...auth, async (req, res) => {
  await pool.query('DELETE FROM dns_forward_zones WHERE id = $1', [req.params.id]);
  const redis = require('../redis');
  await redis.del('classguard:forward-zones').catch(() => {});
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Sync helper
// ---------------------------------------------------------------------------

async function syncController(controllerId) {
  const { rows } = await pool.query('SELECT * FROM network_controllers WHERE id = $1', [controllerId]);
  if (!rows.length) throw new Error('Controller not found');
  const controller = rows[0];

  try {
    const adapter = getAdapter(controller.vendor);
    const clients = await adapter.fetchClients(controller);

    // Some vendors' client API (UniFi in particular) only reports the AP's
    // or switch's MAC on each client, not its name - names only exist on the
    // device list. Cross-reference it here so wireless clients show their AP
    // name and wired clients their switch name instead of a MAC address.
    let deviceNameByMac = new Map();
    if (adapter.fetchDevices) {
      try {
        const devices = await adapter.fetchDevices(controller);
        deviceNameByMac = new Map(devices.map(d => [(d.mac || '').toLowerCase(), d.name]));
      } catch (e) {
        console.warn(`[network] could not fetch devices for AP/switch name resolution (${controller.name}): ${e.message}`);
      }
    }

    // Upsert all clients
    for (const c of clients) {
      if (!c.mac) continue;
      const apName = c.ap_name || deviceNameByMac.get(c.ap_mac) || c.ap_mac || null;
      // uplink_name is the controller's cached resolution — the live device
      // list wins when the same MAC resolves both ways (e.g. after a rename).
      const switchName = c.switch_name || deviceNameByMac.get(c.switch_mac) || c.uplink_name || c.switch_mac || null;
      await pool.query(
        `INSERT INTO network_clients
           (controller_id, mac, ip_address, hostname, ap_name, ssid, rssi, channel, radio_type,
            switch_name, switch_port, vlan, connection_type, status, vendor_oui, os_type,
            first_seen, last_seen, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
         ON CONFLICT (controller_id, mac) DO UPDATE SET
           ip_address = EXCLUDED.ip_address, hostname = EXCLUDED.hostname,
           ap_name = EXCLUDED.ap_name, ssid = EXCLUDED.ssid, rssi = EXCLUDED.rssi,
           channel = EXCLUDED.channel, radio_type = EXCLUDED.radio_type,
           switch_name = EXCLUDED.switch_name, switch_port = EXCLUDED.switch_port,
           vlan = EXCLUDED.vlan, connection_type = EXCLUDED.connection_type,
           status = EXCLUDED.status, vendor_oui = EXCLUDED.vendor_oui,
           os_type = EXCLUDED.os_type, last_seen = EXCLUDED.last_seen,
           raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
        [controllerId, c.mac, c.ip_address, c.hostname, apName, c.ssid,
         c.rssi, c.channel, c.radio_type, switchName, c.switch_port,
         c.vlan, c.connection_type, c.status, c.vendor_oui, c.os_type,
         c.first_seen, c.last_seen, JSON.stringify(c.raw_data)]
      );
    }

    await pool.query(
      'UPDATE network_controllers SET last_sync = NOW(), last_error = NULL WHERE id = $1',
      [controllerId]
    );
    console.log(`[network] synced ${clients.length} clients from controller ${controller.name}`);
  } catch (err) {
    await pool.query(
      'UPDATE network_controllers SET last_error = $1 WHERE id = $2',
      [err.message, controllerId]
    );
    throw err;
  }
}

module.exports = router;
module.exports.syncController = syncController;
