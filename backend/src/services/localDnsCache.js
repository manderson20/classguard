// localDnsCache.js — Keep Redis in sync with dns_zone_records table.
// The DNS engine reads from Redis for sub-millisecond local record lookups.

const redis  = require('../redis');
const { query } = require('../db');

const RECORDS_KEY = 'classguard:dns:local:records'; // Hash: "{TYPE}:{fqdn}" → JSON answers
const ZONES_KEY   = 'classguard:dns:local:zones';   // Set of active zone names

// DNS type number map (matches dns2 Packet.TYPE)
const TYPE_NUM = { A:1, NS:2, CNAME:5, SOA:6, PTR:12, MX:15, TXT:16, AAAA:28, SRV:33 };

// ---------------------------------------------------------------------------
// Compute the absolute FQDN for a record within a zone
// ---------------------------------------------------------------------------
function getFqdn(zoneName, recordName) {
  const z = zoneName.toLowerCase();
  const n = recordName.trim();
  if (n === '@' || n === '') return z;
  if (n.endsWith('.')) return n.slice(0, -1).toLowerCase(); // already absolute
  return `${n.toLowerCase()}.${z}`;
}

// ---------------------------------------------------------------------------
// Build the dns2-compatible answer objects for a record row
// ---------------------------------------------------------------------------
function buildAnswers(record, fqdn) {
  const base = { name: fqdn, class: 1, ttl: record.ttl || 300 };
  const type = record.type.toUpperCase();
  switch (type) {
    case 'A':    return [{ ...base, type: TYPE_NUM.A,    address: record.value }];
    case 'AAAA': return [{ ...base, type: TYPE_NUM.AAAA, address: record.value }];
    case 'CNAME':return [{ ...base, type: TYPE_NUM.CNAME,domain:  record.value }];
    case 'MX':   return [{ ...base, type: TYPE_NUM.MX,   priority: record.priority ?? 10, exchange: record.value }];
    case 'TXT':  return [{ ...base, type: TYPE_NUM.TXT,  data: [record.value] }];
    case 'PTR':  return [{ ...base, type: TYPE_NUM.PTR,  domain:  record.value }];
    case 'NS':   return [{ ...base, type: TYPE_NUM.NS,   ns:      record.value }];
    case 'SRV':  return [{ ...base, type: TYPE_NUM.SRV,
      priority: record.priority ?? 0,
      weight:   record.weight   ?? 0,
      port:     record.port     ?? 0,
      target:   record.value,
    }];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Rebuild the full Redis cache from Postgres
// Called after bulk changes or on demand.
// ---------------------------------------------------------------------------
async function rebuildCache() {
  const { rows: zones } = await query(
    `SELECT id, name FROM dns_zones WHERE is_active = true`
  );
  const { rows: records } = await query(
    `SELECT dr.*, dz.name AS zone_name
     FROM dns_zone_records dr
     JOIN dns_zones dz ON dz.id = dr.zone_id
     WHERE dr.is_active = true AND dz.is_active = true`
  );

  // Group answers by "{TYPE}:{fqdn}"
  const map = new Map();
  for (const rec of records) {
    const fqdn = getFqdn(rec.zone_name, rec.name);
    const key  = `${rec.type.toUpperCase()}:${fqdn}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(...buildAnswers(rec, fqdn));
  }

  const pipeline = redis.pipeline();
  pipeline.del(RECORDS_KEY);
  pipeline.del(ZONES_KEY);
  for (const z of zones) pipeline.sadd(ZONES_KEY, z.name.toLowerCase());
  for (const [field, answers] of map) pipeline.hset(RECORDS_KEY, field, JSON.stringify(answers));
  await pipeline.exec();

  return { zones: zones.length, records: records.length, keys: map.size };
}

// ---------------------------------------------------------------------------
// Update cache for a single record (upsert or delete)
// ---------------------------------------------------------------------------
async function upsertRecordCache(record, zoneName) {
  const fqdn = getFqdn(zoneName, record.name);
  const key  = `${record.type.toUpperCase()}:${fqdn}`;

  if (!record.is_active) {
    // Remove this specific value from the array rather than wiping all records of this type
    const raw = await redis.hget(RECORDS_KEY, key).catch(() => null);
    if (raw) {
      try {
        const existing = JSON.parse(raw);
        const answers  = buildAnswers(record, fqdn);
        const filtered = existing.filter(a => !answers.some(b => JSON.stringify(a) === JSON.stringify(b)));
        if (filtered.length) {
          await redis.hset(RECORDS_KEY, key, JSON.stringify(filtered));
        } else {
          await redis.hdel(RECORDS_KEY, key);
        }
      } catch {}
    }
    return;
  }

  // Merge new answers — rebuild all records for this (type, fqdn) from DB to stay correct
  const { rows } = await query(
    `SELECT dr.* FROM dns_zone_records dr
     JOIN dns_zones dz ON dz.id = dr.zone_id
     WHERE dr.is_active = true AND dz.is_active = true
       AND dz.name = $1
       AND dr.type = $2
       AND (
         ($3 = '@' AND dr.name = '@') OR
         dr.name = $4 OR
         dr.name = $5
       )`,
    [
      zoneName,
      record.type,
      record.name,
      record.name,
      getFqdn(zoneName, record.name) + '.',
    ]
  );
  const answers = rows.flatMap(r => buildAnswers(r, fqdn));
  if (answers.length) {
    await redis.hset(RECORDS_KEY, key, JSON.stringify(answers));
  } else {
    await redis.hdel(RECORDS_KEY, key);
  }
}

// ---------------------------------------------------------------------------
// Update zone membership in the zones set
// ---------------------------------------------------------------------------
async function syncZone(zoneName, isActive) {
  if (isActive) {
    await redis.sadd(ZONES_KEY, zoneName.toLowerCase());
  } else {
    await redis.srem(ZONES_KEY, zoneName.toLowerCase());
  }
}

module.exports = { rebuildCache, upsertRecordCache, syncZone, getFqdn, buildAnswers };
