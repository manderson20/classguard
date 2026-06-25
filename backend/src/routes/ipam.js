// IPAM — IP Address Management
// Subnets: dhcp_subnets table (authoritative)
// Addresses: ip_addresses table (static documentation)
// Live leases: pulled from Kea Control Agent on demand

const { Router } = require('express');
const axios      = require('axios');
const { query, withTransaction, pool } = require('../db');
const { authenticate }    = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const config              = require('../config');
const dhcpKeaSync          = require('../services/dhcpKeaSync');
const { syncNetworkClientsToIpam } = require('../services/ipamSync');
const { lookupVendor }    = require('../services/macVendor');
const pingScan             = require('../services/pingScan');
const phpipamDumpImport    = require('../services/phpipamDumpImport');
const dhcpReservations     = require('../services/dhcpReservations');

const router = Router();
router.use(authenticate, requirePermission('ipam'));

// ---------------------------------------------------------------------------
// Audit helper — fire-and-forget, never blocks the main operation
// ---------------------------------------------------------------------------
async function audit(table, recordId, action, summary, oldData, newData, userId) {
  query(
    `INSERT INTO ipam_audit (table_name,record_id,action,summary,old_data,new_data,changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [table, recordId, action, summary,
     oldData  ? JSON.stringify(oldData)  : null,
     newData  ? JSON.stringify(newData)  : null,
     userId ?? null]
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Overlap helper — returns conflicting subnet if the new CIDR overlaps anything
// in the same VRF (same VRF = same vrf_id including both NULL)
// ---------------------------------------------------------------------------
async function findOverlap(subnet, vrfId, excludeId = null) {
  const conds = ['($1::inet <<= s.subnet OR $1::inet >>= s.subnet)'];
  const vals  = [subnet];
  conds.push(`s.vrf_id IS NOT DISTINCT FROM $${vals.length + 1}`); vals.push(vrfId ?? null);
  if (excludeId) { conds.push(`s.id != $${vals.length + 1}`); vals.push(excludeId); }
  const { rows } = await query(
    `SELECT subnet, name FROM ipam_subnets s WHERE ${conds.join(' AND ')} LIMIT 1`, vals
  );
  return rows[0] ?? null;
}

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
  res.json(rows.map(r => ({ ...r, mac_vendor: lookupVendor(r.mac_address) })));
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
  audit('ipam_sections', rows[0].id, 'INSERT', `Created section ${name}`, null, rows[0], req.user.userId);
  res.status(201).json(rows[0]);
});

router.put('/sections/:id', async (req, res) => {
  const { name, description, parent_id, color } = req.body;
  const { rows: before } = await query('SELECT * FROM ipam_sections WHERE id=$1', [req.params.id]);
  if (!before[0]) return res.status(404).json({ error: 'Section not found' });
  const { rows } = await query(
    `UPDATE ipam_sections SET name=COALESCE($2,name), description=$3, parent_id=$4, color=$5
     WHERE id=$1 RETURNING *`,
    [req.params.id, name, description ?? null, parent_id ?? null, color ?? null]
  );
  audit('ipam_sections', req.params.id, 'UPDATE', `Updated section ${before[0].name}`, before[0], rows[0], req.user.userId);
  res.json(rows[0]);
});

router.delete('/sections/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM ipam_sections WHERE id=$1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Section not found' });
  audit('ipam_sections', rows[0].id, 'DELETE', `Deleted section ${rows[0].name}`, rows[0], null, req.user.userId);
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
    audit('vrfs', rows[0].id, 'INSERT', `Created VRF ${name}`, null, rows[0], req.user.userId);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'VRF name already exists' });
    throw err;
  }
});

router.put('/vrfs/:id', async (req, res) => {
  const { name, rd, description } = req.body;
  const { rows: before } = await query('SELECT * FROM vrfs WHERE id=$1', [req.params.id]);
  if (!before[0]) return res.status(404).json({ error: 'VRF not found' });
  const { rows } = await query(
    `UPDATE vrfs SET name=COALESCE($2,name), rd=$3, description=$4 WHERE id=$1 RETURNING *`,
    [req.params.id, name, rd ?? null, description ?? null]
  );
  audit('vrfs', req.params.id, 'UPDATE', `Updated VRF ${before[0].name}`, before[0], rows[0], req.user.userId);
  res.json(rows[0]);
});

router.delete('/vrfs/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM vrfs WHERE id=$1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'VRF not found' });
  audit('vrfs', rows[0].id, 'DELETE', `Deleted VRF ${rows[0].name}`, rows[0], null, req.user.userId);
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
    audit('vlans', rows[0].id, 'INSERT', `Created VLAN ${vlan_id} ${name || ''}`.trim(), null, rows[0], req.user.userId);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'VLAN ID already exists' });
    throw err;
  }
});

router.put('/vlans/:id', async (req, res) => {
  const { name, description, section_id } = req.body;
  const { rows: before } = await query('SELECT * FROM vlans WHERE id=$1', [req.params.id]);
  if (!before[0]) return res.status(404).json({ error: 'VLAN not found' });
  const { rows } = await query(
    `UPDATE vlans SET name=$2, description=$3, section_id=$4 WHERE id=$1 RETURNING *`,
    [req.params.id, name ?? null, description ?? null, section_id ?? null]
  );
  audit('vlans', req.params.id, 'UPDATE', `Updated VLAN ${before[0].vlan_id}`, before[0], rows[0], req.user.userId);
  res.json(rows[0]);
});

router.delete('/vlans/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM vlans WHERE id=$1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'VLAN not found' });
  audit('vlans', rows[0].id, 'DELETE', `Deleted VLAN ${rows[0].vlan_id}`, rows[0], null, req.user.userId);
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
  audit('locations', rows[0].id, 'INSERT', `Created location ${name}`, null, rows[0], req.user.userId);
  res.status(201).json(rows[0]);
});

router.put('/locations/:id', async (req, res) => {
  const { name, address, description, lat, lng } = req.body;
  const { rows: before } = await query('SELECT * FROM locations WHERE id=$1', [req.params.id]);
  if (!before[0]) return res.status(404).json({ error: 'Location not found' });
  const { rows } = await query(
    `UPDATE locations SET name=COALESCE($2,name), address=$3, description=$4, lat=$5, lng=$6
     WHERE id=$1 RETURNING *`,
    [req.params.id, name, address ?? null, description ?? null, lat ?? null, lng ?? null]
  );
  audit('locations', req.params.id, 'UPDATE', `Updated location ${before[0].name}`, before[0], rows[0], req.user.userId);
  res.json(rows[0]);
});

router.delete('/locations/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM locations WHERE id=$1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Location not found' });
  audit('locations', rows[0].id, 'DELETE', `Deleted location ${rows[0].name}`, rows[0], null, req.user.userId);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Multicast groups (e.g. VoIP paging zones spanning multiple closets)
// ---------------------------------------------------------------------------

router.get('/multicast', async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, v.vlan_id AS vlan_tag, v.name AS vlan_name, l.name AS location_name
     FROM multicast_groups m
     LEFT JOIN vlans v     ON v.id = m.vlan_id
     LEFT JOIN locations l ON l.id = m.location_id
     ORDER BY m.group_address`
  );
  res.json(rows);
});

router.post('/multicast', async (req, res) => {
  const { group_address, name, description, vlan_id, location_id, application, port, is_active, notes } = req.body;
  if (!group_address || !name) return res.status(400).json({ error: 'group_address and name required' });
  try {
    const { rows } = await query(
      `INSERT INTO multicast_groups
         (group_address, name, description, vlan_id, location_id, application, port, is_active, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [group_address, name, description ?? null, vlan_id ?? null, location_id ?? null,
       application || 'other', port ?? null, is_active ?? true, notes ?? null, req.user.userId]
    );
    audit('multicast_groups', rows[0].id, 'INSERT', `Created multicast group ${name} (${group_address})`, null, rows[0], req.user.userId);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That multicast group address is already in use' });
    if (err.code === '23514') return res.status(400).json({ error: 'group_address must be in the multicast range (224.0.0.0/4 or ff00::/8)' });
    throw err;
  }
});

router.put('/multicast/:id', async (req, res) => {
  const { group_address, name, description, vlan_id, location_id, application, port, is_active, notes } = req.body;
  const { rows: before } = await query('SELECT * FROM multicast_groups WHERE id=$1', [req.params.id]);
  if (!before[0]) return res.status(404).json({ error: 'Multicast group not found' });
  try {
    const { rows } = await query(
      `UPDATE multicast_groups SET
         group_address=COALESCE($2,group_address), name=COALESCE($3,name), description=$4,
         vlan_id=$5, location_id=$6, application=$7, port=$8, is_active=$9, notes=$10, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, group_address, name, description ?? null, vlan_id ?? null, location_id ?? null,
       application || 'other', port ?? null, is_active ?? true, notes ?? null]
    );
    audit('multicast_groups', req.params.id, 'UPDATE', `Updated multicast group ${before[0].name}`, before[0], rows[0], req.user.userId);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That multicast group address is already in use' });
    if (err.code === '23514') return res.status(400).json({ error: 'group_address must be in the multicast range (224.0.0.0/4 or ff00::/8)' });
    throw err;
  }
});

router.delete('/multicast/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM multicast_groups WHERE id=$1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Multicast group not found' });
  audit('multicast_groups', rows[0].id, 'DELETE', `Deleted multicast group ${rows[0].name}`, rows[0], null, req.user.userId);
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

// Helper: create or update the linked dhcp_subnets row from an IPAM subnet
async function syncDhcpScope(ipamSubnet, userId) {
  if (!ipamSubnet.dhcp_enabled || !ipamSubnet.dhcp_pool_start || !ipamSubnet.dhcp_pool_end) {
    // Disable DHCP scope if it was previously enabled
    if (ipamSubnet.dhcp_subnet_id) {
      await query('UPDATE dhcp_subnets SET is_active=false WHERE id=$1', [ipamSubnet.dhcp_subnet_id]);
    }
    return;
  }

  const dnsArr = ipamSubnet.dns_servers?.length ? ipamSubnet.dns_servers : ['127.0.0.1'];

  if (ipamSubnet.dhcp_subnet_id) {
    // Update existing DHCP scope
    const { rows } = await query(
      `UPDATE dhcp_subnets
       SET label=$2, pool_start=$3, pool_end=$4, gateway=$5, dns_servers=$6, is_active=true, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [ipamSubnet.dhcp_subnet_id, ipamSubnet.name ?? ipamSubnet.subnet,
       ipamSubnet.dhcp_pool_start, ipamSubnet.dhcp_pool_end,
       ipamSubnet.gateway ?? null, dnsArr]
    );
    if (rows[0]) dhcpKeaSync.run().catch(e => console.warn('[ipam] Kea sync:', e.message));
  } else {
    // Create new DHCP scope — auto-assign next kea_subnet_id
    const { rows: maxRow } = await query('SELECT COALESCE(MAX(kea_subnet_id),0)+1 AS next_id FROM dhcp_subnets');
    const keaId = maxRow[0].next_id;
    const { rows } = await query(
      `INSERT INTO dhcp_subnets
         (kea_subnet_id, subnet, label, pool_start, pool_end, gateway, dns_servers, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [keaId, ipamSubnet.subnet, ipamSubnet.name ?? ipamSubnet.subnet,
       ipamSubnet.dhcp_pool_start, ipamSubnet.dhcp_pool_end,
       ipamSubnet.gateway ?? null, dnsArr, userId]
    );
    if (rows[0]) {
      await query('UPDATE ipam_subnets SET dhcp_subnet_id=$1 WHERE id=$2', [rows[0].id, ipamSubnet.id]);
      dhcpKeaSync.run().catch(e => console.warn('[ipam] Kea sync:', e.message));
    }
  }
}

router.post('/ipam-subnets', async (req, res) => {
  const {
    subnet, ip_version = 4, name, description, section_id, vrf_id, vlan_id,
    location_id, parent_id, gateway, dns_servers, tags, notes,
    dhcp_enabled = false, dhcp_pool_start, dhcp_pool_end,
    alert_threshold_pct, scan_enabled = true,
  } = req.body;
  if (!subnet) return res.status(400).json({ error: 'subnet required' });

  // Overlap detection — warn if this CIDR overlaps an existing subnet in the same VRF
  const overlap = await findOverlap(subnet, vrf_id ?? null);
  if (overlap) {
    return res.status(409).json({
      error: `Overlaps existing subnet ${overlap.subnet}${overlap.name ? ` (${overlap.name})` : ''}`,
      overlap: true, conflicting: overlap.subnet,
    });
  }

  try {
    const { rows } = await query(
      `INSERT INTO ipam_subnets
         (subnet,ip_version,name,description,section_id,vrf_id,vlan_id,location_id,
          parent_id,gateway,dns_servers,tags,notes,dhcp_enabled,dhcp_pool_start,dhcp_pool_end,
          alert_threshold_pct,scan_enabled,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [subnet, ip_version, name??null, description??null, section_id??null, vrf_id??null,
       vlan_id??null, location_id??null, parent_id??null, gateway??null,
       dns_servers ?? [], tags ?? [], notes??null,
       dhcp_enabled, dhcp_pool_start??null, dhcp_pool_end??null,
       alert_threshold_pct ?? 90, scan_enabled,
       req.user.userId]
    );
    const row = rows[0];
    await syncDhcpScope(row, req.user.userId);
    const { rows: fresh } = await query('SELECT * FROM ipam_subnets WHERE id=$1', [row.id]);
    audit('ipam_subnets', row.id, 'INSERT', `Created ${subnet}`, null, fresh[0], req.user.userId);
    res.status(201).json(fresh[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Subnet already exists in this VRF' });
    throw err;
  }
});

router.put('/ipam-subnets/:id', async (req, res) => {
  const allowed = ['name','description','section_id','vrf_id','vlan_id','location_id',
                   'parent_id','gateway','dns_servers','tags','notes','is_full','allow_requests',
                   'is_public','dhcp_enabled','dhcp_pool_start','dhcp_pool_end','alert_threshold_pct','scan_enabled'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  const { rows: [before] } = await query('SELECT * FROM ipam_subnets WHERE id=$1', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Subnet not found' });

  const sets = fields.map((f,i) => `${f}=$${i+2}`).join(', ');
  const vals = fields.map(f => req.body[f]);
  const { rows } = await query(
    `UPDATE ipam_subnets SET ${sets}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...vals]
  );
  await syncDhcpScope(rows[0], req.user.userId);
  const { rows: fresh } = await query('SELECT * FROM ipam_subnets WHERE id=$1', [req.params.id]);
  audit('ipam_subnets', req.params.id, 'UPDATE', `Updated ${before.subnet}`, before, fresh[0], req.user.userId);
  res.json(fresh[0]);
});

router.delete('/ipam-subnets/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM ipam_subnets WHERE id=$1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Subnet not found' });
  audit('ipam_subnets', req.params.id, 'DELETE', `Deleted ${rows[0].subnet}`, rows[0], null, req.user.userId);
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
  audit('bgp_prefixes', rows[0].id, 'INSERT', `Created BGP prefix ${prefix}`, null, rows[0], req.user.userId);
  res.status(201).json(rows[0]);
});

router.put('/bgp/:id', async (req, res) => {
  const allowed = ['description','asn','peer_asn','peer_ip','next_hop','origin','status','communities','vrf_id','notes'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows: before } = await query('SELECT * FROM bgp_prefixes WHERE id=$1', [req.params.id]);
  if (!before[0]) return res.status(404).json({ error: 'BGP prefix not found' });
  const sets = fields.map((f,i) => `${f}=$${i+2}`).join(', ');
  const { rows } = await query(
    `UPDATE bgp_prefixes SET ${sets}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...fields.map(f => req.body[f])]
  );
  audit('bgp_prefixes', req.params.id, 'UPDATE', `Updated BGP prefix ${before[0].prefix}`, before[0], rows[0], req.user.userId);
  res.json(rows[0]);
});

router.delete('/bgp/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM bgp_prefixes WHERE id=$1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'BGP prefix not found' });
  audit('bgp_prefixes', rows[0].id, 'DELETE', `Deleted BGP prefix ${rows[0].prefix}`, rows[0], null, req.user.userId);
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
    `SELECT nr.*, ia.ip AS private_ip, ia.hostname AS private_hostname
     FROM nat_rules nr
     LEFT JOIN ip_addresses ia ON ia.nat_rule_id = nr.id
     ${where} ORDER BY nr.name`, vals
  );
  res.json(rows);
});

// GET /ipam/public-ips — IPs that belong to subnets marked is_public=true, used
// by the NAT pairing picker in the IP edit modal.
router.get('/public-ips', async (req, res) => {
  const { rows } = await query(
    `SELECT ia.id, ia.ip, ia.hostname, ia.description, s.subnet, s.name AS subnet_name
     FROM ip_addresses ia
     JOIN ipam_subnets s ON s.id = ia.ipam_subnet_id
     WHERE s.is_public = true
     ORDER BY ia.ip`
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
  audit('nat_rules', rows[0].id, 'INSERT', `Created NAT rule ${name}`, null, rows[0], req.user.userId);
  res.status(201).json(rows[0]);
});

router.put('/nat/:id', async (req, res) => {
  const allowed = ['name','nat_type','src_prefix','dst_prefix','translated_src','translated_dst',
                   'src_port','dst_port','translated_port','protocol','interface','description','is_active','notes'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows: before } = await query('SELECT * FROM nat_rules WHERE id=$1', [req.params.id]);
  if (!before[0]) return res.status(404).json({ error: 'NAT rule not found' });
  const sets = fields.map((f,i) => `"${f}"=$${i+2}`).join(', ');
  const { rows } = await query(
    `UPDATE nat_rules SET ${sets}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...fields.map(f => req.body[f])]
  );
  audit('nat_rules', req.params.id, 'UPDATE', `Updated NAT rule ${before[0].name}`, before[0], rows[0], req.user.userId);
  res.json(rows[0]);
});

router.delete('/nat/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM nat_rules WHERE id=$1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'NAT rule not found' });
  audit('nat_rules', rows[0].id, 'DELETE', `Deleted NAT rule ${rows[0].name}`, rows[0], null, req.user.userId);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// IP Addresses — scoped to an IPAM subnet
// ---------------------------------------------------------------------------

// GET /ipam/ipam-subnets/:id/addresses?status=&search=&page=1&page_size=50
// When the subnet is IPv4 and fits within 65534 hosts (≤ /16) and no text
// search is active, free IPs are enumerated inline so the list is a complete
// picture of the subnet — every row is either documented or "Available".
// For larger subnets or when a search term is present, only documented IPs
// are returned (free-IP enumeration is skipped for performance).
router.get('/ipam-subnets/:id/addresses', async (req, res) => {
  const { status, search } = req.query;
  const page      = Math.max(1, parseInt(req.query.page, 10) || 1);
  const page_size = Math.min(200, Math.max(10, parseInt(req.query.page_size, 10) || 50));
  const MAX_ENUMERATE = 65534; // /16 — beyond this, skip free-IP enumeration

  const [{ rows: allAddresses }, { rows: sub }] = await Promise.all([
    query(
      `SELECT ia.*, nr.translated_src AS nat_public_ip
       FROM ip_addresses ia
       LEFT JOIN nat_rules nr ON nr.id = ia.nat_rule_id
       WHERE ia.ipam_subnet_id = $1 ORDER BY ia.ip`,
      [req.params.id]
    ),
    query('SELECT subnet, ip_version FROM ipam_subnets WHERE id = $1', [req.params.id]),
  ]);

  const subnetInfo = sub[0];
  const total = subnetInfo ? hostCount(subnetInfo.subnet, subnetInfo.ip_version) : 0;

  // Per-status counts from documented IPs (used for filter tab labels)
  const util = {
    total,
    used:     allAddresses.filter(a => a.status === 'used').length,
    reserved: allAddresses.filter(a => a.status === 'reserved').length,
    offline:  allAddresses.filter(a => a.status === 'offline').length,
    free:     Math.max(0, total - allAddresses.filter(a => a.status !== 'free').length),
  };

  const withVendor = allAddresses.map(a => ({ ...a, mac_vendor: lookupVendor(a.mac_address) }));

  const canEnumerate = !search &&
    subnetInfo?.ip_version !== 6 &&
    total > 0 &&
    total <= MAX_ENUMERATE;

  let rows;

  if (canEnumerate) {
    // Build the complete per-IP map from documented addresses
    const documentedMap = new Map(withVendor.map(a => [a.ip.toString(), a]));

    // Enumerate every host IP in the CIDR
    const [networkStr, prefixStr] = subnetInfo.subnet.split('/');
    const prefix      = parseInt(prefixStr, 10);
    const networkInt  = ipToInt(networkStr);
    const hostMask    = (1 << (32 - prefix)) - 1;
    const networkBase = (networkInt & ~hostMask) >>> 0;
    const firstHost   = prefix >= 31 ? networkBase : networkBase + 1;
    const lastHost    = prefix >= 31 ? networkBase + hostMask : (networkBase + hostMask - 1) >>> 0;

    rows = [];
    for (let n = firstHost; n <= lastHost; n++) {
      const ip = intToIp(n);
      rows.push(documentedMap.has(ip) ? documentedMap.get(ip) : { ip, status: 'free', _synthetic: true });
    }

    if (status) rows = rows.filter(r => r.status === status);
  } else {
    rows = withVendor;
    if (search) {
      const s = search.toLowerCase();
      rows = rows.filter(a =>
        (a.ip && String(a.ip).includes(s)) ||
        (a.hostname    && a.hostname.toLowerCase().includes(s)) ||
        (a.owner       && a.owner.toLowerCase().includes(s)) ||
        (a.mac_address && String(a.mac_address).toLowerCase().includes(s)) ||
        (a.description && a.description.toLowerCase().includes(s)) ||
        (a.tags        && a.tags.some(t => t.toLowerCase().includes(s)))
      );
    }
    if (status) rows = rows.filter(r => r.status === status);
  }

  const total_rows  = rows.length;
  const total_pages = Math.ceil(total_rows / page_size) || 1;
  const start = (page - 1) * page_size;

  res.json({
    addresses: rows.slice(start, start + page_size),
    utilization: util,
    pagination: { page, page_size, total_rows, total_pages, showing_free_ips: canEnumerate },
  });
});

// POST /ipam/ipam-subnets/:id/addresses
router.post('/ipam-subnets/:id/addresses', async (req, res) => {
  const {
    ip, hostname, mac_address, owner, device_type, status = 'used',
    description, notes, is_gateway = false,
  } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  try {
    const { rows } = await query(
      `INSERT INTO ip_addresses
         (ipam_subnet_id, ip, hostname, mac_address, owner, device_type, status, description, notes, is_gateway, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, ip, hostname||null, mac_address||null, owner||null,
       device_type||null, status, description||null, notes||null, is_gateway, req.user.userId]
    );
    const row = rows[0];
    audit('ip_addresses', row.id, 'INSERT', `Added ${ip} to subnet ${req.params.id}`, null, row, req.user.userId);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'IP address already exists' });
    throw err;
  }
});

// PUT /ipam/ipam-subnets/:id/addresses/:ipId
router.put('/ipam-subnets/:id/addresses/:ipId', async (req, res) => {
  const allowed = ['hostname','mac_address','owner','device_type','status','description','notes','is_gateway','ping_status','last_seen','tags'];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  const hasNatChange = 'nat_public_ip' in req.body;
  if (!fields.length && !hasNatChange) return res.status(400).json({ error: 'Nothing to update' });

  const { rows: [before] } = await query('SELECT * FROM ip_addresses WHERE id=$1', [req.params.ipId]);
  if (!before) return res.status(404).json({ error: 'IP not found' });

  let natRuleId = before.nat_rule_id;
  if (hasNatChange) {
    const publicIp = req.body.nat_public_ip;
    if (publicIp) {
      const privateHost = `${before.ip}/32`;
      const publicHost  = publicIp.includes('/') ? publicIp : `${publicIp}/32`;
      const ruleName    = before.hostname ? `${before.hostname} (NAT)` : `${before.ip} → ${publicIp}`;
      if (natRuleId) {
        const { rows: [existing] } = await query(
          `UPDATE nat_rules SET src_prefix=$1, translated_src=$2, name=$3, updated_at=NOW()
           WHERE id=$4 RETURNING id`,
          [privateHost, publicHost, ruleName, natRuleId]
        );
        if (!existing) natRuleId = null; // rule was deleted manually, fall through to create
      }
      if (!natRuleId) {
        const { rows: [newRule] } = await query(
          `INSERT INTO nat_rules (name, nat_type, src_prefix, translated_src, is_active, description, created_by)
           VALUES ($1, 'static', $2, $3, true, 'Auto-created from IPAM pairing', $4) RETURNING id`,
          [ruleName, privateHost, publicHost, req.user.userId]
        );
        natRuleId = newRule.id;
      }
    } else {
      natRuleId = null; // clearing the pairing; keep the NAT rule itself intact
    }
    fields.push('nat_rule_id');
  }

  const allVals = hasNatChange
    ? [...fields.slice(0, -1).map(f => req.body[f]), natRuleId]
    : fields.map(f => req.body[f]);

  const sets = fields.map((f, i) => `${f}=$${i+3}`).join(', ');
  // Reaching this route means an admin used the Edit modal — claim the row
  // away from the lease-sync job (services/dhcpLeaseIpamSync.js) so a later
  // lease expiry reverts rather than deletes it.
  const { rows } = await query(
    `UPDATE ip_addresses SET ${sets}, lease_managed=false, updated_at=NOW()
     WHERE id=$1 AND ipam_subnet_id=$2 RETURNING *`,
    [req.params.ipId, req.params.id, ...allVals]
  );
  if (!rows[0]) return res.status(404).json({ error: 'IP not found' });
  audit('ip_addresses', req.params.ipId, 'UPDATE', `Updated ${rows[0].ip}`, before, rows[0], req.user.userId);
  res.json(rows[0]);
});

// DELETE /ipam/ipam-subnets/:id/addresses/:ipId
router.delete('/ipam-subnets/:id/addresses/:ipId', async (req, res) => {
  const { rows } = await query(
    'DELETE FROM ip_addresses WHERE id=$1 AND ipam_subnet_id=$2 RETURNING *',
    [req.params.ipId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'IP not found' });
  audit('ip_addresses', req.params.ipId, 'DELETE', `Deleted ${rows[0].ip}`, rows[0], null, req.user.userId);
  res.json({ deleted: true });
});

// POST /ipam/ipam-subnets/:id/addresses/:ipId/reserve-dhcp
// Creates a real DHCP reservation (pushed live to Kea) for this address, via
// the same path as the DHCP module's Reservations tab — requires the IPAM
// subnet to be linked to a DHCP scope (dhcp_enabled + dhcp_subnet_id) and the
// address to have a MAC on file (a reservation is keyed by MAC, not IP).
router.post('/ipam-subnets/:id/addresses/:ipId/reserve-dhcp', async (req, res) => {
  const { rows: [subnet] } = await query('SELECT * FROM ipam_subnets WHERE id = $1', [req.params.id]);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });
  if (!subnet.dhcp_enabled || !subnet.dhcp_subnet_id) {
    return res.status(400).json({ error: 'This subnet is not linked to a DHCP scope — enable DHCP on the subnet first' });
  }

  const { rows: [addr] } = await query('SELECT * FROM ip_addresses WHERE id = $1 AND ipam_subnet_id = $2', [req.params.ipId, req.params.id]);
  if (!addr) return res.status(404).json({ error: 'IP not found' });

  const mac = req.body.mac_address || addr.mac_address;
  if (!mac) return res.status(400).json({ error: 'A MAC address is required to reserve this IP for DHCP' });

  try {
    const reservation = await dhcpReservations.createReservation({
      subnetId: subnet.dhcp_subnet_id, macAddress: mac, ipAddress: addr.ip,
      hostname: addr.hostname, notes: addr.notes, userId: req.user.userId,
    });
    const { rows: [updated] } = await query('SELECT * FROM ip_addresses WHERE id = $1', [req.params.ipId]);
    audit('ip_addresses', req.params.ipId, 'UPDATE', `Reserved ${addr.ip} for DHCP`, addr, updated, req.user.userId);
    res.status(201).json({ reservation, address: updated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// DELETE /ipam/ipam-subnets/:id/addresses/:ipId/reserve-dhcp — remove the
// backing DHCP reservation (the address row itself isn't deleted; it falls
// back to address_status='static' via dhcpIpamSync.removeReservationFromIpam)
router.delete('/ipam-subnets/:id/addresses/:ipId/reserve-dhcp', async (req, res) => {
  const { rows: [addr] } = await query('SELECT * FROM ip_addresses WHERE id = $1 AND ipam_subnet_id = $2', [req.params.ipId, req.params.id]);
  if (!addr) return res.status(404).json({ error: 'IP not found' });
  if (!addr.dhcp_reservation_id) return res.status(400).json({ error: 'This address has no DHCP reservation to remove' });

  try {
    await dhcpReservations.deleteReservation(addr.dhcp_reservation_id);
    const { rows: [updated] } = await query('SELECT * FROM ip_addresses WHERE id = $1', [req.params.ipId]);
    audit('ip_addresses', req.params.ipId, 'UPDATE', `Removed DHCP reservation for ${addr.ip}`, addr, updated, req.user.userId);
    res.json({ address: updated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// GET /ipam/ipam-subnets/:id/next-free
// POST /ipam/ipam-subnets/:id/scan — on-demand presence (ping) sweep
router.post('/ipam-subnets/:id/scan', async (req, res) => {
  const { rows: subs } = await query('SELECT id, subnet, ip_version FROM ipam_subnets WHERE id=$1', [req.params.id]);
  if (!subs[0]) return res.status(404).json({ error: 'Subnet not found' });
  try {
    const result = await pingScan.scanSubnet(subs[0]);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Scan failed: ${err.message}` });
  }
});

router.get('/ipam-subnets/:id/next-free', async (req, res) => {
  const { rows: subs } = await query('SELECT subnet, ip_version FROM ipam_subnets WHERE id=$1', [req.params.id]);
  if (!subs[0]) return res.status(404).json({ error: 'Subnet not found' });
  if (subs[0].ip_version !== 4) return res.json({ ip: null });

  const { rows } = await query(
    `WITH used_ips AS (SELECT ip FROM ip_addresses WHERE ipam_subnet_id = $1)
     SELECT host((s.subnet + g.n)::inet) AS ip
     FROM ipam_subnets s
     CROSS JOIN generate_series(1, LEAST(65534, (2^(32 - masklen(s.subnet)) - 2)::int)) AS g(n)
     WHERE s.id = $1
       AND (s.subnet + g.n)::inet NOT IN (SELECT ip FROM used_ips)
       AND g.n < (2^(32 - masklen(s.subnet)) - 1)::int
     ORDER BY (s.subnet + g.n)::inet LIMIT 1`,
    [req.params.id]
  );
  res.json({ ip: rows[0]?.ip ?? null });
});

// GET /ipam/search?q=
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.status(400).json({ error: 'q must be at least 2 chars' });
  const { rows } = await query(
    `SELECT ia.id, ia.ip, ia.hostname, ia.owner, ia.mac_address, ia.status, ia.device_type,
            ia.description, s.subnet, s.name AS subnet_name, s.id AS subnet_id
     FROM ip_addresses ia
     LEFT JOIN ipam_subnets s ON s.id = ia.ipam_subnet_id
     WHERE ia.ipam_subnet_id IS NOT NULL
       AND (ia.ip::text ILIKE $1 OR ia.hostname ILIKE $1 OR ia.owner ILIKE $1
            OR ia.mac_address::text ILIKE $1 OR ia.description ILIKE $1)
     ORDER BY ia.ip LIMIT 100`,
    [`%${q}%`]
  );
  res.json(rows.map(r => ({ ...r, mac_vendor: lookupVendor(r.mac_address) })));
});

// ---------------------------------------------------------------------------
// Subnet split — create equal-sized child subnets
// ---------------------------------------------------------------------------
router.post('/ipam-subnets/:id/split', async (req, res) => {
  const newPrefix = parseInt(req.body.prefix, 10);
  if (isNaN(newPrefix) || newPrefix < 1 || newPrefix > 30) {
    return res.status(400).json({ error: 'prefix must be between 1 and 30' });
  }

  const { rows: [parent] } = await query('SELECT * FROM ipam_subnets WHERE id = $1', [req.params.id]);
  if (!parent) return res.status(404).json({ error: 'Subnet not found' });

  const parentPrefix = parseInt(parent.subnet.split('/')[1], 10);
  if (newPrefix <= parentPrefix) {
    return res.status(400).json({ error: `Split prefix /${newPrefix} must be larger than parent /${parentPrefix}` });
  }

  const count = Math.pow(2, newPrefix - parentPrefix);
  if (count > 1024) {
    return res.status(400).json({ error: `Would create ${count.toLocaleString()} subnets — limit is 1,024. Choose a larger prefix.` });
  }

  const step = Math.pow(2, 32 - newPrefix);

  // CTE pre-computes the base host address (strips the prefix length from the parent CIDR)
  const { rows: inserted } = await query(
    `WITH base AS (SELECT host(network($1::inet))::inet AS b)
     INSERT INTO ipam_subnets (subnet, parent_id, ip_version, created_by)
     SELECT (host(base.b + (g.n * $3::bigint)) || '/' || $2)::inet,
            $4, $5, $6
     FROM generate_series(0, $7::int - 1) AS g(n), base
     WHERE NOT EXISTS (
       SELECT 1 FROM ipam_subnets s2
       WHERE s2.subnet = (host(base.b + (g.n * $3::bigint)) || '/' || $2)::inet
     )
     RETURNING id, subnet`,
    [parent.subnet, newPrefix, step, parent.id, parent.ip_version, req.user.userId, count]
  );

  res.json({ created: inserted.length, skipped: count - inserted.length });
});

// ---------------------------------------------------------------------------
// CSV Import — subnets
// ---------------------------------------------------------------------------
router.post('/import/subnets', async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows provided' });

  let imported = 0, skipped = 0;
  const errors = [];

  for (const row of rows) {
    const subnet = (row.subnet || '').trim();
    if (!subnet) { errors.push('Row missing subnet field'); continue; }

    try {
      let section_id = null;
      if (row.section?.trim()) {
        const sr = await query('SELECT id FROM ipam_sections WHERE name ILIKE $1 LIMIT 1', [row.section.trim()]);
        section_id = sr.rows[0]?.id ?? null;
      }

      let vlan_db_id = null;
      if (row.vlan_id?.trim()) {
        const vr = await query('SELECT id FROM vlans WHERE vlan_id = $1 LIMIT 1', [parseInt(row.vlan_id, 10)]);
        vlan_db_id = vr.rows[0]?.id ?? null;
      }

      const ip_version = parseInt(row.ip_version, 10) || 4;
      const { rowCount } = await query(
        `INSERT INTO ipam_subnets
           (subnet, name, gateway, ip_version, description, notes, section_id, vlan_id, created_by)
         SELECT $1::inet, $2, $3, $4, $5, $6, $7, $8, $9
         WHERE NOT EXISTS (SELECT 1 FROM ipam_subnets WHERE subnet = $1::inet)`,
        [subnet, row.name?.trim() || null, row.gateway?.trim() || null, ip_version,
         row.description?.trim() || null, row.notes?.trim() || null,
         section_id, vlan_db_id, req.user?.userId ?? null]
      );
      if (rowCount > 0) imported++; else skipped++;
    } catch (e) {
      errors.push(`${subnet}: ${e.message}`);
    }
  }

  res.json({ imported, skipped, errors });
});

// ---------------------------------------------------------------------------
// CSV Import — IP addresses
// ---------------------------------------------------------------------------
router.post('/import/addresses', async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows provided' });

  let imported = 0, skipped = 0;
  const errors = [];
  const subnetCache = {};

  for (const row of rows) {
    const subnetCidr = (row.subnet || '').trim();
    const ip         = (row.ip    || '').trim();
    if (!subnetCidr || !ip) {
      errors.push(`Row missing subnet or ip: ${JSON.stringify(row)}`);
      continue;
    }

    try {
      if (!subnetCache[subnetCidr]) {
        const sr = await query('SELECT id FROM ipam_subnets WHERE subnet = $1::inet LIMIT 1', [subnetCidr]);
        subnetCache[subnetCidr] = sr.rows[0]?.id ?? null;
      }
      const ipam_subnet_id = subnetCache[subnetCidr];
      if (!ipam_subnet_id) {
        errors.push(`${ip}: subnet ${subnetCidr} not found in IPAM`);
        continue;
      }

      const VALID_STATUS = ['used', 'free', 'reserved', 'offline', 'dhcp'];
      const status = VALID_STATUS.includes(row.status?.trim()) ? row.status.trim() : 'used';
      const mac    = row.mac_address?.trim() || null;

      const { rowCount } = await query(
        `INSERT INTO ip_addresses
           (ip, ipam_subnet_id, hostname, mac_address, owner, description, status, device_type)
         SELECT $1::inet, $2, $3, $4::macaddr, $5, $6, $7, $8
         WHERE NOT EXISTS (
           SELECT 1 FROM ip_addresses WHERE ip = $1::inet AND ipam_subnet_id = $2
         )`,
        [ip, ipam_subnet_id, row.hostname?.trim() || null, mac,
         row.owner?.trim() || null, row.description?.trim() || null,
         status, row.device_type?.trim() || null]
      );
      if (rowCount > 0) imported++; else skipped++;
    } catch (e) {
      errors.push(`${ip}: ${e.message}`);
    }
  }

  res.json({ imported, skipped, errors });
});

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------
function csvRow(vals) {
  return vals.map(v => {
    if (v == null) return '';
    const s = Array.isArray(v) ? v.join(';') : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

router.get('/export/subnets', async (req, res) => {
  const { rows } = await query(
    `SELECT s.subnet, s.name, s.gateway, s.ip_version, s.description, s.notes,
            sec.name AS section, v.name AS vrf, vl.vlan_id, s.tags
     FROM ipam_subnets s
     LEFT JOIN ipam_sections sec ON sec.id = s.section_id
     LEFT JOIN vrfs v             ON v.id   = s.vrf_id
     LEFT JOIN vlans vl           ON vl.id  = s.vlan_id
     ORDER BY s.subnet`
  );
  const header = 'subnet,name,gateway,ip_version,description,notes,section,vrf,vlan_id,tags\n';
  const body   = rows.map(r => csvRow([r.subnet, r.name, r.gateway, r.ip_version,
    r.description, r.notes, r.section, r.vrf, r.vlan_id, r.tags])).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="classguard_subnets.csv"');
  res.send(header + body);
});

router.get('/export/addresses', async (req, res) => {
  const { subnet_id } = req.query;
  const where = subnet_id ? 'WHERE ia.ipam_subnet_id = $1' : 'WHERE ia.ipam_subnet_id IS NOT NULL';
  const vals  = subnet_id ? [subnet_id] : [];
  const { rows } = await query(
    `SELECT s.subnet, ia.ip, ia.hostname, ia.mac_address, ia.owner,
            ia.description, ia.status, ia.device_type, ia.last_seen, ia.tags
     FROM ip_addresses ia
     JOIN ipam_subnets s ON s.id = ia.ipam_subnet_id
     ${where} ORDER BY s.subnet, ia.ip`, vals
  );
  const header = 'subnet,ip,hostname,mac_address,owner,description,status,device_type,last_seen,tags\n';
  const body   = rows.map(r => csvRow([r.subnet, r.ip, r.hostname, r.mac_address, r.owner,
    r.description, r.status, r.device_type, r.last_seen, r.tags])).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="classguard_addresses.csv"');
  res.send(header + body);
});

// ---------------------------------------------------------------------------
// Controller → IPAM sync
// ---------------------------------------------------------------------------
router.post('/sync-from-controllers', async (req, res) => {
  const result = await syncNetworkClientsToIpam();
  res.json(result);
});

// POST /ipam/sync-from-integrations — link Mosyle/Google MDM devices into
// IPAM when one of their known IPs matches a documented subnet (devices
// taken home are correctly skipped — see services/integrationDeviceIpamSync.js)
router.post('/sync-from-integrations', async (req, res) => {
  const integrationDeviceIpamSync = require('../services/integrationDeviceIpamSync');
  const result = await integrationDeviceIpamSync.run();
  res.json(result);
});

// ---------------------------------------------------------------------------
// Audit log query
// ---------------------------------------------------------------------------
router.get('/audit', async (req, res) => {
  const { table_name, record_id, limit = 50 } = req.query;
  const conds = [], vals = [];
  if (table_name) { conds.push(`a.table_name=$${vals.length+1}`); vals.push(table_name); }
  if (record_id)  { conds.push(`a.record_id=$${vals.length+1}`);  vals.push(record_id);  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT a.*, u.full_name AS changed_by_name
     FROM ipam_audit a
     LEFT JOIN users u ON u.id = a.changed_by
     ${where} ORDER BY a.changed_at DESC LIMIT $${vals.length+1}`,
    [...vals, parseInt(limit, 10)]
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// IP arithmetic helpers
// ---------------------------------------------------------------------------
function hostCount(cidr, ipVersion = 4) {
  if (ipVersion === 6) return null;
  try {
    const prefix = parseInt(cidr.toString().split('/')[1], 10);
    if (prefix >= 31) return Math.pow(2, 32 - prefix);
    return Math.pow(2, 32 - prefix) - 2;
  } catch { return 0; }
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) | parseInt(oct, 10), 0) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
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

// ---------------------------------------------------------------------------
// PHPiPAM mysqldump import — sections, VLANs, subnets, IP addresses.
// POST body is the raw .sql file text. ?commit=true actually persists;
// without it, runs the same INSERTs inside a transaction and rolls back, so
// the response (counts/warnings/sample rows) reflects exactly what a real
// import would do without writing anything.
// ---------------------------------------------------------------------------
router.post('/import/phpipam-dump', async (req, res) => {
  const sql = typeof req.body === 'string' ? req.body : req.body?.sql;
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ error: 'No SQL dump content provided' });
  }
  try {
    const result = await phpipamDumpImport.run(sql, req.query.commit === 'true');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
