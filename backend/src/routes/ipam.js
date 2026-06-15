// IPAM — IP Address Management
// Subnets: dhcp_subnets table (authoritative)
// Addresses: ip_addresses table (static documentation)
// Live leases: pulled from Kea Control Agent on demand

const { Router } = require('express');
const axios      = require('axios');
const { query, withTransaction } = require('../db');
const { authenticate }    = require('../middleware/auth');
const { requireMinRole }  = require('../middleware/roles');
const config              = require('../config');

const router = Router();
router.use(authenticate, requireMinRole('admin'));

// ---------------------------------------------------------------------------
// Kea helper — fetch current DHCP4 leases for a subnet
// ---------------------------------------------------------------------------
async function keaLeases(subnetId) {
  try {
    const res = await axios.post(config.kea.controlAgentUrl, {
      command: 'lease4-get-all',
      service: ['dhcp4'],
      arguments: { subnets: [subnetId] },
    }, { timeout: 5000 });
    return res.data?.[0]?.arguments?.leases || [];
  } catch {
    return []; // Kea unavailable — degrade gracefully
  }
}

// ---------------------------------------------------------------------------
// Subnet routes  (subnet = dhcp_subnets)
// ---------------------------------------------------------------------------

// GET /api/v1/ipam/subnets
router.get('/subnets', async (req, res) => {
  const { rows } = await query(
    `SELECT s.*,
            COUNT(DISTINCT ia.id)   FILTER (WHERE ia.id IS NOT NULL) AS documented_ips,
            COUNT(DISTINCT dr.id)   FILTER (WHERE dr.id IS NOT NULL) AS dhcp_reservations
     FROM dhcp_subnets s
     LEFT JOIN ip_addresses ia  ON ia.subnet_id  = s.id
     LEFT JOIN dhcp_reservations dr ON dr.subnet_id = s.id
     GROUP BY s.id
     ORDER BY s.subnet`
  );
  res.json(rows);
});

// GET /api/v1/ipam/subnets/:id
router.get('/subnets/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM dhcp_subnets WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Subnet not found' });
  res.json(rows[0]);
});

// POST /api/v1/ipam/subnets — create a subnet (also creates Kea config, Phase 10)
router.post('/subnets', async (req, res) => {
  const {
    kea_subnet_id, subnet, label, pool_start, pool_end,
    gateway, dns_servers, vlan_id, location, notes,
  } = req.body;

  if (!kea_subnet_id || !subnet || !pool_start || !pool_end) {
    return res.status(400).json({ error: 'kea_subnet_id, subnet, pool_start, pool_end required' });
  }

  const { rows } = await query(
    `INSERT INTO dhcp_subnets
       (kea_subnet_id, subnet, label, pool_start, pool_end, gateway, dns_servers, vlan_id, location, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [kea_subnet_id, subnet, label, pool_start, pool_end,
     gateway, dns_servers ? `{${dns_servers.join(',')}}` : null,
     vlan_id, location, notes, req.user.userId]
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/v1/ipam/subnets/:id
router.patch('/subnets/:id', async (req, res) => {
  const allowed = ['label','gateway','dns_servers','vlan_id','location','notes','lease_time_seconds','is_active','ipam_enabled'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No updatable fields' });

  const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map(f => f === 'dns_servers' ? `{${req.body[f].join(',')}}` : req.body[f]);

  const { rows } = await query(
    `UPDATE dhcp_subnets SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Subnet not found' });
  res.json(rows[0]);
});

// DELETE /api/v1/ipam/subnets/:id
router.delete('/subnets/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM dhcp_subnets WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Subnet not found' });
  res.json({ deleted: rows[0].id });
});

// ---------------------------------------------------------------------------
// GET /api/v1/ipam/subnets/:id/map
// Returns a full utilization map: documented static IPs + DHCP reservations +
// live Kea leases.  Used by the Admin Console subnet visualizer.
// ---------------------------------------------------------------------------
router.get('/subnets/:id/map', async (req, res) => {
  const { rows: subnets } = await query('SELECT * FROM dhcp_subnets WHERE id = $1', [req.params.id]);
  if (!subnets[0]) return res.status(404).json({ error: 'Subnet not found' });
  const subnet = subnets[0];

  const [{ rows: staticIPs }, { rows: reservations }, leases] = await Promise.all([
    query(
      `SELECT ia.*, array_to_json(ia.tags) AS tags,
              json_agg(dr.*) FILTER (WHERE dr.id IS NOT NULL) AS dns_records
       FROM ip_addresses ia
       LEFT JOIN dns_records dr ON dr.ip_id = ia.id
       WHERE ia.subnet_id = $1
       GROUP BY ia.id
       ORDER BY ia.ip`,
      [req.params.id]
    ),
    query(
      'SELECT * FROM dhcp_reservations WHERE subnet_id = $1 ORDER BY ip_address',
      [req.params.id]
    ),
    keaLeases(subnet.kea_subnet_id),
  ]);

  // Build a unified IP map
  const ipMap = {};

  staticIPs.forEach(ip => {
    ipMap[ip.ip] = { ...ip, source: 'static' };
  });

  reservations.forEach(r => {
    const key = r.ip_address;
    if (ipMap[key]) {
      ipMap[key].dhcp_reservation = r;
      ipMap[key].source = 'static+reservation';
    } else {
      ipMap[key] = { ip: key, source: 'reservation', dhcp_reservation: r };
    }
  });

  leases.forEach(l => {
    const key = l['ip-address'];
    if (ipMap[key]) {
      ipMap[key].live_lease = l;
      if (!ipMap[key].source.includes('dynamic')) {
        ipMap[key].source += '+dynamic';
      }
    } else {
      ipMap[key] = { ip: key, source: 'dynamic', live_lease: l };
    }
  });

  // Detect conflicts: IP documented as static but also in DHCP pool
  const poolStart = subnet.pool_start;
  const poolEnd   = subnet.pool_end;
  Object.values(ipMap).forEach(entry => {
    if (entry.source === 'static' && entry.is_static &&
        ipInRange(entry.ip, poolStart, poolEnd) &&
        !entry.dhcp_reservation) {
      entry.conflict = 'static_ip_in_dhcp_pool';
    }
  });

  res.json({
    subnet,
    utilization: {
      total:       countIPs(subnet.subnet),
      static:      staticIPs.length,
      reserved:    reservations.length,
      dynamic:     leases.length,
      conflicts:   Object.values(ipMap).filter(e => e.conflict).length,
    },
    addresses: Object.values(ipMap).sort((a, b) => ipCompare(a.ip || a['ip-address'], b.ip || b['ip-address'])),
  });
});

// ---------------------------------------------------------------------------
// IP Address documentation routes
// ---------------------------------------------------------------------------

// GET /api/v1/ipam/addresses?subnet_id=&device_type=&search=
router.get('/addresses', async (req, res) => {
  const { subnet_id, device_type, search } = req.query;
  const conditions = [];
  const values     = [];

  if (subnet_id) {
    conditions.push(`ia.subnet_id = $${values.length + 1}`);
    values.push(subnet_id);
  }
  if (device_type) {
    conditions.push(`ia.device_type = $${values.length + 1}`);
    values.push(device_type);
  }
  if (search) {
    conditions.push(`(ia.hostname ILIKE $${values.length + 1} OR ia.description ILIKE $${values.length + 1} OR ia.owner ILIKE $${values.length + 1} OR ia.ip::text LIKE $${values.length + 1})`);
    values.push(`%${search}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT ia.*, s.subnet AS subnet_cidr, s.label AS subnet_label,
            array_to_json(ia.tags) AS tags
     FROM ip_addresses ia
     LEFT JOIN dhcp_subnets s ON s.id = ia.subnet_id
     ${where}
     ORDER BY ia.ip`,
    values
  );
  res.json(rows);
});

// GET /api/v1/ipam/addresses/:id
router.get('/addresses/:id', async (req, res) => {
  const [{ rows: ips }, { rows: dns }] = await Promise.all([
    query(
      `SELECT ia.*, s.subnet AS subnet_cidr, s.label AS subnet_label
       FROM ip_addresses ia
       LEFT JOIN dhcp_subnets s ON s.id = ia.subnet_id
       WHERE ia.id = $1`,
      [req.params.id]
    ),
    query('SELECT * FROM dns_records WHERE ip_id = $1 ORDER BY record_type, name', [req.params.id]),
  ]);
  if (!ips[0]) return res.status(404).json({ error: 'IP record not found' });
  res.json({ ...ips[0], dns_records: dns });
});

// POST /api/v1/ipam/addresses
router.post('/addresses', async (req, res) => {
  const {
    subnet_id, ip, hostname, description, device_type,
    mac_address, owner, tags = [], notes, is_gateway = false, is_static = true,
    dns_records = [],
  } = req.body;

  if (!ip) return res.status(400).json({ error: 'ip is required' });

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO ip_addresses
         (subnet_id, ip, hostname, description, device_type, mac_address, owner, tags, notes, is_gateway, is_static, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [subnet_id, ip, hostname, description, device_type,
       mac_address, owner, `{${tags.join(',')}}`, notes, is_gateway, is_static, req.user.userId]
    );

    const ipRow = rows[0];
    for (const rec of dns_records) {
      await client.query(
        `INSERT INTO dns_records (ip_id, record_type, name, value, ttl, zone, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ipRow.id, rec.record_type, rec.name, rec.value, rec.ttl || 3600, rec.zone, rec.notes]
      );
    }

    return ipRow;
  });

  res.status(201).json(result);
});

// PATCH /api/v1/ipam/addresses/:id
router.patch('/addresses/:id', async (req, res) => {
  const allowed = ['hostname','description','device_type','mac_address','owner','tags','notes','is_gateway','is_static','subnet_id'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No updatable fields' });

  const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map(f => f === 'tags' ? `{${(req.body[f] || []).join(',')}}` : req.body[f]);

  const { rows } = await query(
    `UPDATE ip_addresses SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );
  if (!rows[0]) return res.status(404).json({ error: 'IP record not found' });
  res.json(rows[0]);
});

// DELETE /api/v1/ipam/addresses/:id
router.delete('/addresses/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM ip_addresses WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'IP record not found' });
  res.json({ deleted: rows[0].id });
});

// ---------------------------------------------------------------------------
// DNS record sub-routes
// ---------------------------------------------------------------------------

// POST /api/v1/ipam/addresses/:id/dns
router.post('/addresses/:id/dns', async (req, res) => {
  const { record_type, name, value, ttl = 3600, zone, notes } = req.body;
  if (!record_type || !name || !value) {
    return res.status(400).json({ error: 'record_type, name, value required' });
  }
  const { rows } = await query(
    `INSERT INTO dns_records (ip_id, record_type, name, value, ttl, zone, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.id, record_type.toUpperCase(), name, value, ttl, zone, notes]
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/v1/ipam/addresses/:ipId/dns/:dnsId
router.delete('/addresses/:ipId/dns/:dnsId', async (req, res) => {
  const { rows } = await query(
    'DELETE FROM dns_records WHERE id = $1 AND ip_id = $2 RETURNING id',
    [req.params.dnsId, req.params.ipId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'DNS record not found' });
  res.json({ deleted: rows[0].id });
});

// ---------------------------------------------------------------------------
// GET /api/v1/ipam/leases?subnet_kea_id=  — live Kea leases (read-only)
// ---------------------------------------------------------------------------
router.get('/leases', async (req, res) => {
  const { subnet_kea_id } = req.query;
  if (!subnet_kea_id) return res.status(400).json({ error: 'subnet_kea_id required' });
  const leases = await keaLeases(parseInt(subnet_kea_id, 10));
  res.json(leases);
});

// ---------------------------------------------------------------------------
// IP arithmetic helpers
// ---------------------------------------------------------------------------
function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) | parseInt(oct, 10), 0) >>> 0;
}

function ipInRange(ip, start, end) {
  try {
    const n = ipToInt(ip);
    return n >= ipToInt(start) && n <= ipToInt(end);
  } catch { return false; }
}

function ipCompare(a, b) {
  try { return ipToInt(a) - ipToInt(b); } catch { return 0; }
}

function countIPs(cidr) {
  try {
    const [, prefix] = cidr.split('/');
    return Math.pow(2, 32 - parseInt(prefix, 10)) - 2; // exclude network + broadcast
  } catch { return 0; }
}

module.exports = router;
