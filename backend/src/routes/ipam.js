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
// IPAM Sections
// ---------------------------------------------------------------------------

router.get('/sections', async (req, res) => {
  const { rows } = await query(`SELECT * FROM ipam_sections ORDER BY name`);
  res.json(rows);
});

router.post('/sections', async (req, res) => {
  const { name, description, parent_id, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await query(
    `INSERT INTO ipam_sections (name, description, parent_id, color, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, description ?? null, parent_id ?? null, color ?? null, req.user.userId]
  );
  res.status(201).json(rows[0]);
});

router.put('/sections/:id', async (req, res) => {
  const { name, description, parent_id, color } = req.body;
  const { rows } = await query(
    `UPDATE ipam_sections SET name=COALESCE($2,name), description=$3, parent_id=$4, color=$5
     WHERE id=$1 RETURNING *`,
    [req.params.id, name, description ?? null, parent_id ?? null, color ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Section not found' });
  res.json(rows[0]);
});

router.delete('/sections/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM ipam_sections WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Section not found' });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// VRFs
// ---------------------------------------------------------------------------

router.get('/vrfs', async (req, res) => {
  const { rows } = await query(`SELECT * FROM vrfs ORDER BY name`);
  res.json(rows);
});

router.post('/vrfs', async (req, res) => {
  const { name, rd, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await query(
      `INSERT INTO vrfs (name, rd, description, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, rd ?? null, description ?? null, req.user.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'VRF name already exists' });
    throw err;
  }
});

router.put('/vrfs/:id', async (req, res) => {
  const { name, rd, description } = req.body;
  const { rows } = await query(
    `UPDATE vrfs SET name=COALESCE($2,name), rd=$3, description=$4 WHERE id=$1 RETURNING *`,
    [req.params.id, name, rd ?? null, description ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'VRF not found' });
  res.json(rows[0]);
});

router.delete('/vrfs/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM vrfs WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'VRF not found' });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// VLANs
// ---------------------------------------------------------------------------

router.get('/vlans', async (req, res) => {
  const { rows } = await query(
    `SELECT v.*, s.name AS section_name FROM vlans v
     LEFT JOIN ipam_sections s ON s.id = v.section_id
     ORDER BY v.vlan_id`
  );
  res.json(rows);
});

router.post('/vlans', async (req, res) => {
  const { vlan_id, name, description, section_id } = req.body;
  if (!vlan_id) return res.status(400).json({ error: 'vlan_id required' });
  try {
    const { rows } = await query(
      `INSERT INTO vlans (vlan_id, name, description, section_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [vlan_id, name ?? null, description ?? null, section_id ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'VLAN ID already exists' });
    throw err;
  }
});

router.put('/vlans/:id', async (req, res) => {
  const { name, description, section_id } = req.body;
  const { rows } = await query(
    `UPDATE vlans SET name=$2, description=$3, section_id=$4 WHERE id=$1 RETURNING *`,
    [req.params.id, name ?? null, description ?? null, section_id ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'VLAN not found' });
  res.json(rows[0]);
});

router.delete('/vlans/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM vlans WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'VLAN not found' });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

router.get('/locations', async (req, res) => {
  const { rows } = await query(`SELECT * FROM locations ORDER BY name`);
  res.json(rows);
});

router.post('/locations', async (req, res) => {
  const { name, address, description, parent_id, lat, lng } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await query(
    `INSERT INTO locations (name, address, description, parent_id, lat, lng)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, address ?? null, description ?? null, parent_id ?? null, lat ?? null, lng ?? null]
  );
  res.status(201).json(rows[0]);
});

router.put('/locations/:id', async (req, res) => {
  const { name, address, description, lat, lng } = req.body;
  const { rows } = await query(
    `UPDATE locations SET name=COALESCE($2,name), address=$3, description=$4, lat=$5, lng=$6
     WHERE id=$1 RETURNING *`,
    [req.params.id, name, address ?? null, description ?? null, lat ?? null, lng ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Location not found' });
  res.json(rows[0]);
});

router.delete('/locations/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM locations WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Location not found' });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// IPAM Subnets (IPv4 + IPv6, nested)
// ---------------------------------------------------------------------------

router.get('/ipam-subnets', async (req, res) => {
  const { section_id, vrf_id, ip_version, parent_id } = req.query;
  const conds = [], vals = [];
  if (section_id)  { conds.push(`s.section_id  = $${vals.length+1}`); vals.push(section_id); }
  if (vrf_id)      { conds.push(`s.vrf_id      = $${vals.length+1}`); vals.push(vrf_id); }
  if (ip_version)  { conds.push(`s.ip_version  = $${vals.length+1}`); vals.push(ip_version); }
  if (parent_id === 'null') { conds.push('s.parent_id IS NULL'); }
  else if (parent_id) { conds.push(`s.parent_id = $${vals.length+1}`); vals.push(parent_id); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT s.*,
            sec.name AS section_name,
            v.name AS vrf_name,
            vl.vlan_id, vl.name AS vlan_name,
            l.name AS location_name,
            COUNT(ia.id) AS ip_count
     FROM ipam_subnets s
     LEFT JOIN ipam_sections sec ON sec.id = s.section_id
     LEFT JOIN vrfs v            ON v.id   = s.vrf_id
     LEFT JOIN vlans vl          ON vl.id  = s.vlan_id
     LEFT JOIN locations l       ON l.id   = s.location_id
     LEFT JOIN ip_addresses ia   ON ia.ipam_subnet_id = s.id
     ${where}
     GROUP BY s.id, sec.name, v.name, vl.vlan_id, vl.name, l.name
     ORDER BY s.subnet`, vals
  );
  res.json(rows);
});

router.get('/ipam-subnets/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, sec.name AS section_name, v.name AS vrf_name,
            vl.vlan_id, vl.name AS vlan_name, l.name AS location_name
     FROM ipam_subnets s
     LEFT JOIN ipam_sections sec ON sec.id = s.section_id
     LEFT JOIN vrfs v            ON v.id   = s.vrf_id
     LEFT JOIN vlans vl          ON vl.id  = s.vlan_id
     LEFT JOIN locations l       ON l.id   = s.location_id
     WHERE s.id = $1`, [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Subnet not found' });

  // Children
  const { rows: children } = await query(
    'SELECT * FROM ipam_subnets WHERE parent_id = $1 ORDER BY subnet', [req.params.id]
  );
  res.json({ ...rows[0], children });
});

router.post('/ipam-subnets', async (req, res) => {
  const {
    subnet, ip_version = 4, name, description, section_id, vrf_id, vlan_id,
    location_id, parent_id, gateway, dns_servers, tags, notes,
  } = req.body;
  if (!subnet) return res.status(400).json({ error: 'subnet required' });
  try {
    const { rows } = await query(
      `INSERT INTO ipam_subnets
         (subnet,ip_version,name,description,section_id,vrf_id,vlan_id,location_id,
          parent_id,gateway,dns_servers,tags,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [subnet, ip_version, name??null, description??null, section_id??null, vrf_id??null,
       vlan_id??null, location_id??null, parent_id??null, gateway??null,
       dns_servers ?? [], tags ?? [], notes??null, req.user.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Subnet already exists in this VRF' });
    throw err;
  }
});

router.put('/ipam-subnets/:id', async (req, res) => {
  const allowed = ['name','description','section_id','vrf_id','vlan_id','location_id',
                   'parent_id','gateway','dns_servers','tags','notes','is_full','allow_requests'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  const sets = fields.map((f,i) => `${f}=$${i+2}`).join(', ');
  const vals = fields.map(f => req.body[f]);
  const { rows } = await query(
    `UPDATE ipam_subnets SET ${sets}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...vals]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Subnet not found' });
  res.json(rows[0]);
});

router.delete('/ipam-subnets/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM ipam_subnets WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Subnet not found' });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// BGP Prefixes
// ---------------------------------------------------------------------------

router.get('/bgp', async (req, res) => {
  const { ip_version, status, asn } = req.query;
  const conds = [], vals = [];
  if (ip_version) { conds.push(`ip_version=$${vals.length+1}`); vals.push(ip_version); }
  if (status)     { conds.push(`status=$${vals.length+1}`);     vals.push(status); }
  if (asn)        { conds.push(`(asn=$${vals.length+1} OR peer_asn=$${vals.length+1})`); vals.push(parseInt(asn, 10)); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT b.*, v.name AS vrf_name FROM bgp_prefixes b
     LEFT JOIN vrfs v ON v.id = b.vrf_id
     ${where} ORDER BY b.prefix`, vals
  );
  res.json(rows);
});

router.post('/bgp', async (req, res) => {
  const { prefix, ip_version=4, description, asn, peer_asn, peer_ip, next_hop,
          origin, status='active', communities=[], vrf_id, notes } = req.body;
  if (!prefix) return res.status(400).json({ error: 'prefix required' });
  const { rows } = await query(
    `INSERT INTO bgp_prefixes
       (prefix,ip_version,description,asn,peer_asn,peer_ip,next_hop,origin,status,communities,vrf_id,notes,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [prefix, ip_version, description??null, asn??null, peer_asn??null, peer_ip??null,
     next_hop??null, origin??null, status, communities, vrf_id??null, notes??null, req.user.userId]
  );
  res.status(201).json(rows[0]);
});

router.put('/bgp/:id', async (req, res) => {
  const allowed = ['description','asn','peer_asn','peer_ip','next_hop','origin','status','communities','vrf_id','notes'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  const sets = fields.map((f,i) => `${f}=$${i+2}`).join(', ');
  const { rows } = await query(
    `UPDATE bgp_prefixes SET ${sets}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...fields.map(f => req.body[f])]
  );
  if (!rows[0]) return res.status(404).json({ error: 'BGP prefix not found' });
  res.json(rows[0]);
});

router.delete('/bgp/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM bgp_prefixes WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'BGP prefix not found' });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// NAT Rules
// ---------------------------------------------------------------------------

router.get('/nat', async (req, res) => {
  const { nat_type, is_active } = req.query;
  const conds = [], vals = [];
  if (nat_type)  { conds.push(`nat_type=$${vals.length+1}`);  vals.push(nat_type); }
  if (is_active !== undefined) { conds.push(`is_active=$${vals.length+1}`); vals.push(is_active === 'true'); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM nat_rules ${where} ORDER BY name`, vals
  );
  res.json(rows);
});

router.post('/nat', async (req, res) => {
  const {
    name, nat_type, src_prefix, dst_prefix, translated_src, translated_dst,
    src_port, dst_port, translated_port, protocol='any', interface: iface,
    description, is_active=true, notes,
  } = req.body;
  if (!name || !nat_type) return res.status(400).json({ error: 'name and nat_type required' });
  const { rows } = await query(
    `INSERT INTO nat_rules
       (name,nat_type,src_prefix,dst_prefix,translated_src,translated_dst,
        src_port,dst_port,translated_port,protocol,interface,description,is_active,notes,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [name, nat_type, src_prefix??null, dst_prefix??null, translated_src??null,
     translated_dst??null, src_port??null, dst_port??null, translated_port??null,
     protocol, iface??null, description??null, is_active, notes??null, req.user.userId]
  );
  res.status(201).json(rows[0]);
});

router.put('/nat/:id', async (req, res) => {
  const allowed = ['name','nat_type','src_prefix','dst_prefix','translated_src','translated_dst',
                   'src_port','dst_port','translated_port','protocol','interface','description','is_active','notes'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  const sets = fields.map((f,i) => `"${f}"=$${i+2}`).join(', ');
  const { rows } = await query(
    `UPDATE nat_rules SET ${sets}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...fields.map(f => req.body[f])]
  );
  if (!rows[0]) return res.status(404).json({ error: 'NAT rule not found' });
  res.json(rows[0]);
});

router.delete('/nat/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM nat_rules WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'NAT rule not found' });
  res.json({ deleted: true });
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
