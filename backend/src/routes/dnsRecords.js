// dnsRecords.js — CRUD for local DNS zones and records
const express  = require('express');
const { query }   = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  rebuildCache, upsertRecordCache, syncZone, getFqdn,
} = require('../services/localDnsCache');
const windowsDnsImport = require('../services/windowsDnsImport');

const router    = express.Router();
const adminOnly = [authenticate, requirePermission('dns_records')];

// priority/weight/port are smallint columns and only apply to MX/SRV records —
// the form sends '' for them on every other record type, which Postgres
// rejects outright ("invalid input syntax for type smallint"). Treat blank as NULL.
const toIntOrNull = v => (v === '' || v === undefined || v === null) ? null : parseInt(v, 10);

// ---------------------------------------------------------------------------
// GET /dns/zones
// ---------------------------------------------------------------------------
router.get('/zones', ...adminOnly, async (req, res) => {
  const { rows } = await query(`
    SELECT dz.*,
           COUNT(dr.id)::int AS record_count
    FROM dns_zones dz
    LEFT JOIN dns_zone_records dr ON dr.zone_id = dz.id AND dr.is_active = true
    GROUP BY dz.id
    ORDER BY dz.name
  `);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /dns/zones
// ---------------------------------------------------------------------------
router.post('/zones', ...adminOnly, async (req, res) => {
  const { name, type = 'forward', description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const clean = name.trim().toLowerCase().replace(/\.$/, '');
  const { rows: [zone] } = await query(
    `INSERT INTO dns_zones (name, type, description)
     VALUES ($1, $2, $3) RETURNING *`,
    [clean, type, description || null]
  );
  await syncZone(zone.name, zone.is_active);
  res.status(201).json(zone);
});

// ---------------------------------------------------------------------------
// PUT /dns/zones/:id
// ---------------------------------------------------------------------------
router.put('/zones/:id', ...adminOnly, async (req, res) => {
  const { name, type, description, is_active } = req.body;
  const { rows: [zone] } = await query(
    `UPDATE dns_zones
     SET name = COALESCE($1, name),
         type = COALESCE($2, type),
         description = COALESCE($3, description),
         is_active = COALESCE($4, is_active),
         updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [name?.trim().toLowerCase().replace(/\.$/, '') || null, type || null, description ?? null, is_active ?? null, req.params.id]
  );
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  await syncZone(zone.name, zone.is_active);
  if (is_active === false) {
    // Rebuild to remove all records for this zone from cache
    await rebuildCache();
  }
  res.json(zone);
});

// ---------------------------------------------------------------------------
// DELETE /dns/zones/:id
// ---------------------------------------------------------------------------
router.delete('/zones/:id', ...adminOnly, async (req, res) => {
  const { rows: [zone] } = await query(
    'DELETE FROM dns_zones WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  await rebuildCache(); // full rebuild to purge all records for this zone
  res.json({ deleted: zone });
});

// ---------------------------------------------------------------------------
// GET /dns/zones/:id/records
// ---------------------------------------------------------------------------
router.get('/zones/:id/records', ...adminOnly, async (req, res) => {
  const { type, name } = req.query;
  const conditions = ['dr.zone_id = $1'];
  const vals       = [req.params.id];
  if (type)  { vals.push(type.toUpperCase());  conditions.push(`dr.type = $${vals.length}`); }
  if (name)  { vals.push(`%${name}%`);         conditions.push(`dr.name ILIKE $${vals.length}`); }
  const { rows } = await query(
    `SELECT dr.* FROM dns_zone_records dr
     WHERE ${conditions.join(' AND ')}
     ORDER BY dr.type, dr.name`,
    vals
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /dns/zones/:id/records
// ---------------------------------------------------------------------------
router.post('/zones/:id/records', ...adminOnly, async (req, res) => {
  const { rows: [zone] } = await query('SELECT * FROM dns_zones WHERE id = $1', [req.params.id]);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const { name, type, value, ttl = 300, priority, weight, port } = req.body;
  if (!name || !type || !value) {
    return res.status(400).json({ error: 'name, type, and value are required' });
  }

  const { rows: [record] } = await query(
    `INSERT INTO dns_zone_records (zone_id, name, type, value, ttl, priority, weight, port)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [zone.id, name.trim(), type.toUpperCase(), value.trim(), ttl,
     toIntOrNull(priority), toIntOrNull(weight), toIntOrNull(port)]
  );
  await upsertRecordCache(record, zone.name);
  res.status(201).json({ ...record, fqdn: getFqdn(zone.name, record.name) });
});

// ---------------------------------------------------------------------------
// PUT /dns/records/:id
// ---------------------------------------------------------------------------
router.put('/records/:id', ...adminOnly, async (req, res) => {
  const { rows: [existing] } = await query(
    `SELECT dr.*, dz.name AS zone_name FROM dns_zone_records dr
     JOIN dns_zones dz ON dz.id = dr.zone_id WHERE dr.id = $1`,
    [req.params.id]
  );
  if (!existing) return res.status(404).json({ error: 'Record not found' });

  const { name, type, value, ttl, priority, weight, port, is_active } = req.body;

  // If key fields changed, invalidate the old cache entry first
  if ((name && name !== existing.name) || (type && type !== existing.type)) {
    await upsertRecordCache({ ...existing, is_active: false }, existing.zone_name);
  }

  const { rows: [record] } = await query(
    `UPDATE dns_zone_records
     SET name      = COALESCE($1, name),
         type      = COALESCE($2, type),
         value     = COALESCE($3, value),
         ttl       = COALESCE($4, ttl),
         priority  = COALESCE($5, priority),
         weight    = COALESCE($6, weight),
         port      = COALESCE($7, port),
         is_active = COALESCE($8, is_active),
         updated_at = NOW()
     WHERE id = $9 RETURNING *`,
    [
      name?.trim() ?? null, type?.toUpperCase() ?? null, value?.trim() ?? null,
      toIntOrNull(ttl), toIntOrNull(priority), toIntOrNull(weight), toIntOrNull(port),
      is_active ?? null, req.params.id,
    ]
  );
  await upsertRecordCache(record, existing.zone_name);
  res.json({ ...record, fqdn: getFqdn(existing.zone_name, record.name) });
});

// ---------------------------------------------------------------------------
// DELETE /dns/records/:id
// ---------------------------------------------------------------------------
router.delete('/records/:id', ...adminOnly, async (req, res) => {
  const { rows: [record] } = await query(
    `SELECT dr.*, dz.name AS zone_name FROM dns_zone_records dr
     JOIN dns_zones dz ON dz.id = dr.zone_id WHERE dr.id = $1`,
    [req.params.id]
  );
  if (!record) return res.status(404).json({ error: 'Record not found' });

  await query('DELETE FROM dns_zone_records WHERE id = $1', [req.params.id]);
  await upsertRecordCache({ ...record, is_active: false }, record.zone_name);
  res.json({ deleted: record });
});

// ---------------------------------------------------------------------------
// POST /dns/records/bulk-delete
// Body: { ids: [uuid, ...] } — used for cleaning up old/imported records.
// ---------------------------------------------------------------------------
router.post('/records/bulk-delete', ...adminOnly, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const { rows: deleted } = await query(
    `DELETE FROM dns_zone_records WHERE id = ANY($1::uuid[]) RETURNING id, zone_id`,
    [ids]
  );
  if (deleted.length > 0) await rebuildCache();
  res.json({ deleted: deleted.length });
});

// ---------------------------------------------------------------------------
// POST /dns/zones/import-windows
// Imports a Windows DNS Server "Export List" zone file. Body: { text, zoneName, commit }
// commit=false (preview) runs the same inserts inside a transaction and rolls
// back, so the response reflects exactly what a real import would do.
// ---------------------------------------------------------------------------
router.post('/zones/import-windows', ...adminOnly, async (req, res) => {
  const { text, zoneName, commit } = req.body;
  if (!text || !zoneName) return res.status(400).json({ error: 'text and zoneName are required' });
  try {
    const result = await windowsDnsImport.run(text, zoneName.trim().toLowerCase(), !!commit);
    if (result.committed) await rebuildCache();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /dns/rebuild-local-cache
// ---------------------------------------------------------------------------
router.post('/rebuild-local-cache', ...adminOnly, async (req, res) => {
  const result = await rebuildCache();
  res.json({ ok: true, ...result });
});

// ---------------------------------------------------------------------------
// GET /dns/zones/:id/export
// Export as BIND-style zone file
// ---------------------------------------------------------------------------
router.get('/zones/:id/export', ...adminOnly, async (req, res) => {
  const { rows: [zone] } = await query('SELECT * FROM dns_zones WHERE id = $1', [req.params.id]);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const { rows: records } = await query(
    `SELECT * FROM dns_zone_records WHERE zone_id = $1 AND is_active = true ORDER BY type, name`,
    [zone.id]
  );

  const lines = [
    `; Zone: ${zone.name}`,
    `; Exported: ${new Date().toISOString()}`,
    `; ClassGuard DNS Records`,
    `$ORIGIN ${zone.name}.`,
    `$TTL 300`,
    '',
  ];

  for (const r of records) {
    const name = r.name === '@' ? '@' : r.name;
    switch (r.type) {
      case 'MX':
        lines.push(`${name.padEnd(30)} ${r.ttl} IN MX ${r.priority ?? 10} ${r.value}.`);
        break;
      case 'SRV':
        lines.push(`${name.padEnd(30)} ${r.ttl} IN SRV ${r.priority ?? 0} ${r.weight ?? 0} ${r.port ?? 0} ${r.value}.`);
        break;
      case 'TXT':
        lines.push(`${name.padEnd(30)} ${r.ttl} IN TXT "${r.value}"`);
        break;
      case 'CNAME':
      case 'PTR':
      case 'NS':
        lines.push(`${name.padEnd(30)} ${r.ttl} IN ${r.type} ${r.value}.`);
        break;
      default:
        lines.push(`${name.padEnd(30)} ${r.ttl} IN ${r.type} ${r.value}`);
    }
  }

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${zone.name}.zone"`);
  res.send(lines.join('\n') + '\n');
});

module.exports = router;
