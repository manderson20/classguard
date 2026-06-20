// Imports a Windows DNS Server zone export ("DNS Manager" → right-click a
// zone → "Export List…") into a ClassGuard dns_zones/dns_zone_records pair.
//
// The export is tab-separated text: "Name\tType\tData\tTimestamp". AD-
// integrated zones also include blank-type rows for the SRV-record
// container folders Windows auto-creates (_msdcs, _sites, _tcp, _udp,
// DomainDnsZones, ForestDnsZones) — those aren't real records and are
// skipped, along with the zone-level SOA line (ClassGuard's dns_zones
// doesn't model SOA per-record).
//
// Same dry-run pattern as the other importers this session: runs inside one
// transaction, commit=false rolls back at the end.

const { pool } = require('../db');

function stripTrailingDot(v) {
  return v ? v.replace(/\.$/, '') : v;
}

// Windows shows MX as "[priority] target." and SRV as "[priority][weight][port] target."
function parsePriorityBracketed(data) {
  const nums = [];
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(data))) nums.push(parseInt(m[1], 10));
  const target = stripTrailingDot(data.replace(/\[\d+\]/g, '').trim());
  return { nums, target };
}

function mapRow(name, type, data) {
  const recordName = name === '(same as parent folder)' ? '@' : name;

  if (/^Host \(A\)$/i.test(type))             return { name: recordName, type: 'A',     value: data.trim() };
  if (/^Host \(AAAA\)$/i.test(type))           return { name: recordName, type: 'AAAA',  value: data.trim() };
  if (/^Alias \(CNAME\)$/i.test(type))         return { name: recordName, type: 'CNAME', value: stripTrailingDot(data.trim()) };
  if (/^Name Server \(NS\)$/i.test(type))      return { name: recordName, type: 'NS',    value: stripTrailingDot(data.trim()) };
  if (/^Pointer \(PTR\)$/i.test(type))         return { name: recordName, type: 'PTR',   value: stripTrailingDot(data.trim()) };
  if (/^Text \(TXT\)$/i.test(type))            return { name: recordName, type: 'TXT',   value: data.trim().replace(/^"|"$/g, '') };
  if (/^Mail Exchanger \(MX\)$/i.test(type)) {
    const { nums, target } = parsePriorityBracketed(data);
    return { name: recordName, type: 'MX', value: target, priority: nums[0] ?? 10 };
  }
  if (/^Service Location \(SRV\)$/i.test(type)) {
    const { nums, target } = parsePriorityBracketed(data);
    return { name: recordName, type: 'SRV', value: target, priority: nums[0] ?? 0, weight: nums[1] ?? 0, port: nums[2] ?? 0 };
  }
  return null; // SOA and anything else unrecognized — not imported
}

function parseZoneFile(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const records = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const [name, type, data, timestamp] = cols;
    if (!type || !type.trim()) continue; // folder/container node, not a real record
    const mapped = mapRow(name, type.trim(), data || '');
    if (!mapped) continue;
    mapped.dynamic = !!timestamp && timestamp.trim().toLowerCase() !== 'static';
    records.push(mapped);
  }
  return records;
}

async function run(text, zoneName, commit) {
  const records = parseZoneFile(text);
  if (!records.length) throw new Error('No importable records found — is this a Windows DNS Manager "Export List" file?');

  const warnings = [];
  const sample = [];
  const counts = { records: 0, byType: {} };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let { rows: [zone] } = await client.query('SELECT id FROM dns_zones WHERE name = $1', [zoneName]);
    if (!zone) {
      ({ rows: [zone] } = await client.query(
        `INSERT INTO dns_zones (name, type, description) VALUES ($1,'forward',$2) RETURNING id`,
        [zoneName, 'Imported from Windows DNS Server export']
      ));
    }

    for (const r of records) {
      const sp = `sp_${counts.records}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        await client.query(
          `INSERT INTO dns_zone_records (zone_id, name, type, value, priority, weight, port, ttl, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,300,true)
           ON CONFLICT (zone_id, name, type, value) DO NOTHING`,
          [zone.id, r.name, r.type, r.value, r.priority ?? null, r.weight ?? null, r.port ?? null]
        );
        await client.query(`RELEASE SAVEPOINT ${sp}`);
        counts.records++;
        counts.byType[r.type] = (counts.byType[r.type] || 0) + 1;
        if (sample.length < 8) sample.push({ name: r.name, type: r.type, value: r.value });
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        warnings.push(`${r.name} (${r.type}): ${e.message}`);
      }
    }

    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');

    return { committed: !!commit, zoneName, counts, warnings, sample };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { run, parseZoneFile };
