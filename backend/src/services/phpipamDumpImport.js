// Imports a PHPiPAM MySQL dump (.sql) directly into ClassGuard's IPAM tables.
//
// Built against an actual exported dump rather than guessed CSV headers,
// since PHPiPAM's REST API export shape varies by version and the live API
// integration couldn't be reached on this deployment (Apache rewrite issue
// on the PHPiPAM host, unrelated to ClassGuard).
//
// PHPiPAM stores subnet/IP addresses as decimal-string integers (32-bit for
// IPv4, 128-bit for IPv6) in a single column — BigInt is required to convert
// the IPv6 ones without precision loss.
//
// Runs the whole mapping inside one transaction. commit=false rolls back at
// the end so the caller gets an accurate preview (real INSERTs, real
// constraint checks) without persisting anything.

const { pool } = require('../db');

// ---------------------------------------------------------------------------
// mysqldump extended-INSERT tuple parser
// ---------------------------------------------------------------------------
function parseValuesTuples(blob) {
  const rows = [];
  let row = null;
  let cur = '';
  let inStr = false;
  for (let i = 0; i < blob.length; i++) {
    const c = blob[i];
    if (inStr) {
      if (c === '\\' && i + 1 < blob.length) {
        const next = blob[i + 1];
        const map = { "'": "'", '"': '"', '\\': '\\', n: '\n', r: '\r', '0': '\0', Z: '\x1a', t: '\t' };
        cur += map[next] !== undefined ? map[next] : next;
        i += 1;
        continue;
      }
      if (c === "'") { inStr = false; continue; }
      cur += c;
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    if (c === '(' && row === null) { row = []; cur = ''; continue; }
    if (c === ',' && row !== null) { row.push(cur === 'NULL' ? null : cur); cur = ''; continue; }
    if (c === ')' && row !== null) { row.push(cur === 'NULL' ? null : cur); rows.push(row); row = null; cur = ''; continue; }
    if (row !== null) cur += c;
  }
  return rows;
}

function extractTable(sql, tableName, columns) {
  const re = new RegExp('INSERT INTO `' + tableName + '` VALUES (.+);');
  const m = re.exec(sql);
  if (!m) return [];
  return parseValuesTuples(m[1]).map(vals => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = vals[i] ?? null; });
    return obj;
  });
}

// Column order copied verbatim from each table's CREATE TABLE statement —
// mysqldump INSERTs are positional, not keyed, so this order is load-bearing.
const COLS = {
  sections: ['id', 'name', 'description', 'masterSection', 'permissions', 'strictMode',
    'subnetOrdering', 'order', 'editDate', 'showSubnet', 'showVLAN', 'showVRF', 'showSupernetOnly', 'DNS'],
  vlans: ['vlanId', 'domainId', 'name', 'number', 'description', 'editDate', 'customer_id'],
  subnets: ['id', 'subnet', 'mask', 'sectionId', 'description', 'linked_subnet', 'firewallAddressObject',
    'vrfId', 'masterSubnetId', 'allowRequests', 'vlanId', 'showName', 'device', 'permissions',
    'pingSubnet', 'discoverSubnet', 'resolveDNS', 'DNSrecursive', 'DNSrecords', 'nameserverId',
    'scanAgent', 'customer_id', 'isFolder', 'isFull', 'isPool', 'state', 'threshold', 'location',
    'editDate', 'lastScan', 'lastDiscovery'],
  ipaddresses: ['id', 'subnetId', 'ip_addr', 'is_gateway', 'description', 'hostname', 'mac', 'owner',
    'state', 'switch', 'location', 'port', 'note', 'lastSeen', 'excludePing', 'PTRignore', 'PTR',
    'firewallAddressObject', 'editDate', 'customer_id', 'custom_Switch', 'custom_Interface'],
};

// ---------------------------------------------------------------------------
// Decimal-string IP -> text. PHPiPAM stores both v4 (32-bit) and v6 (128-bit)
// addresses as plain decimal integers in the same column; magnitude alone
// can't distinguish small-valued IPv6 addresses (e.g. ::1) from IPv4, so
// callers pass the known address family from context (the parent subnet's
// mask length) rather than relying on guesswork.
// ---------------------------------------------------------------------------
function intToIp(decimalStr, isV6) {
  const n = BigInt(decimalStr);
  if (!isV6) {
    const v = Number(n);
    return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
  }
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(((n >> BigInt(i * 16)) & 0xFFFFn).toString(16));
  return groups.join(':');
}

const toInt  = v => (v === null || v === '' || v === undefined) ? null : parseInt(v, 10);
const toBool = v => v === '1' || v === 1;

// From this dump's ipTags table — PHPiPAM's default IP state labels.
const STATE_MAP = { 1: 'offline', 2: 'used', 3: 'reserved', 4: 'dhcp' };

async function run(sqlText, commit) {
  const sections     = extractTable(sqlText, 'sections', COLS.sections);
  const vlans         = extractTable(sqlText, 'vlans', COLS.vlans);
  const subnetsRaw    = extractTable(sqlText, 'subnets', COLS.subnets);
  const addressesRaw  = extractTable(sqlText, 'ipaddresses', COLS.ipaddresses);

  if (!sections.length && !subnetsRaw.length) {
    throw new Error('No sections or subnets found in this file — is it a PHPiPAM mysqldump?');
  }

  const warnings = [];
  const sample   = { sections: [], vlans: [], subnets: [], addresses: [] };
  const counts   = {
    sections: 0, vlans: 0, vlansSkippedDuplicate: 0,
    subnets: 0, subnetsSkippedFolder: 0, subnetsSkippedExisting: 0,
    addresses: 0, addressesSkipped: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Sections — reuse by name if this dump has already been imported once ---
    const sectionIdMap = new Map(); // phpIPAM sections.id -> our ipam_sections.id
    for (const s of sections) {
      const existing = await client.query('SELECT id FROM ipam_sections WHERE name = $1', [s.name]);
      if (existing.rows[0]) {
        sectionIdMap.set(s.id, existing.rows[0].id);
      } else {
        const { rows } = await client.query(
          `INSERT INTO ipam_sections (name, description) VALUES ($1,$2) RETURNING id`,
          [s.name, s.description || null]
        );
        sectionIdMap.set(s.id, rows[0].id);
        counts.sections++;
      }
      if (sample.sections.length < 5) sample.sections.push({ name: s.name, description: s.description });
    }

    // --- VLANs — our vlan_id (the 802.1Q tag) must be globally unique, but
    // PHPiPAM data can have the same tag reused under different vlanId PKs
    // (different sites/naming over the years) — merge those into one row. ---
    const vlanIdMap = new Map(); // phpIPAM vlans.vlanId (PK) -> our vlans.id
    for (const v of vlans) {
      const number = toInt(v.number);
      if (!number) { warnings.push(`VLAN "${v.name}" has no tag number — skipped`); continue; }
      const { rows } = await client.query(
        `INSERT INTO vlans (vlan_id, name, description) VALUES ($1,$2,$3)
         ON CONFLICT (vlan_id) DO NOTHING RETURNING id`,
        [number, v.name, v.description || null]
      );
      if (rows[0]) {
        vlanIdMap.set(v.vlanId, rows[0].id);
        counts.vlans++;
        if (sample.vlans.length < 5) sample.vlans.push({ vlan_id: number, name: v.name });
      } else {
        const existing = await client.query('SELECT id FROM vlans WHERE vlan_id = $1', [number]);
        vlanIdMap.set(v.vlanId, existing.rows[0]?.id ?? null);
        counts.vlansSkippedDuplicate++;
        warnings.push(`VLAN tag ${number} ("${v.name}") was already used by another PHPiPAM VLAN entry — merged into one`);
      }
    }

    // --- Subnets ----------------------------------------------------------
    // PHPiPAM "folders" (isFolder=1) are organizational labels with no real
    // CIDR — ClassGuard's ipam_subnets requires a real subnet, so folders are
    // skipped; any real subnet nested under one attaches to the section
    // directly instead of losing its place in the hierarchy.
    const subnetIdMap    = new Map(); // phpIPAM subnets.id -> our ipam_subnets.id (real subnets only)
    const subnetIsFolder = new Map();
    const subnetMaster   = new Map();
    const subnetVersion  = new Map();
    const gatewayCandidate = new Map(); // our ipam_subnets.id -> gateway IP text, applied after addresses import

    for (const s of subnetsRaw) {
      subnetIsFolder.set(s.id, toBool(s.isFolder) || !s.subnet || s.mask === '' || s.mask === null);
      subnetMaster.set(s.id, toInt(s.masterSubnetId) || null);
      if (subnetIsFolder.get(s.id)) { counts.subnetsSkippedFolder++; continue; }

      const prefixLen = toInt(s.mask);
      const version   = prefixLen > 32 ? 6 : 4;
      subnetVersion.set(s.id, version);

      const cidr       = `${intToIp(s.subnet, version === 6)}/${prefixLen}`;
      const sectionId  = sectionIdMap.get(s.sectionId) ?? null;
      const vlanDbId   = s.vlanId ? (vlanIdMap.get(s.vlanId) ?? null) : null;
      const threshold  = toInt(s.threshold);

      try {
        const { rows } = await client.query(
          `INSERT INTO ipam_subnets
             (subnet, ip_version, description, section_id, vlan_id,
              allow_requests, is_full, scan_enabled, alert_threshold_pct)
           VALUES ($1::cidr,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING RETURNING id`,
          [cidr, version, s.description || null, sectionId, vlanDbId,
           toBool(s.allowRequests), toBool(s.isFull), toBool(s.pingSubnet),
           threshold && threshold > 0 ? threshold : 90]
        );
        if (rows[0]) {
          subnetIdMap.set(s.id, rows[0].id);
          counts.subnets++;
          if (sample.subnets.length < 5) sample.subnets.push({ subnet: cidr, description: s.description });
        } else {
          counts.subnetsSkippedExisting++;
          warnings.push(`Subnet ${cidr} already exists in ClassGuard IPAM — skipped`);
        }
      } catch (e) {
        warnings.push(`Subnet ${cidr}: ${e.message}`);
      }
    }

    // Resolve parent_id by walking masterSubnetId chains through skipped folders
    function resolveParent(phpId, depth = 0) {
      if (depth > 20) return null; // guard against unexpected cycles
      const masterId = subnetMaster.get(phpId);
      if (!masterId) return null;
      if (subnetIdMap.get(masterId)) return subnetIdMap.get(masterId);
      if (subnetIsFolder.get(masterId)) return resolveParent(masterId, depth + 1);
      return null;
    }
    for (const s of subnetsRaw) {
      if (!subnetIdMap.get(s.id)) continue;
      const parentId = resolveParent(s.id);
      if (parentId) await client.query('UPDATE ipam_subnets SET parent_id = $1 WHERE id = $2', [parentId, subnetIdMap.get(s.id)]);
    }

    // --- IP addresses -------------------------------------------------------
    for (const a of addressesRaw) {
      const ourSubnetId = subnetIdMap.get(a.subnetId);
      if (!ourSubnetId) { counts.addressesSkipped++; continue; }
      const version    = subnetVersion.get(a.subnetId) || 4;
      const ip          = intToIp(a.ip_addr, version === 6);
      const status      = STATE_MAP[toInt(a.state)] || 'used';
      const lastSeen     = (a.lastSeen && a.lastSeen !== '1970-01-01 00:00:01') ? a.lastSeen : null;
      const mac          = a.mac ? a.mac.replace(/-/g, ':') : null;
      const isGateway    = toBool(a.is_gateway);

      try {
        const { rows } = await client.query(
          `INSERT INTO ip_addresses
             (ipam_subnet_id, ip, ip_version, hostname, description, mac_address, owner, status, notes, is_gateway, last_seen)
           VALUES ($1,$2,$3,$4,$5,$6::macaddr,$7,$8,$9,$10,$11)
           ON CONFLICT (ip, ipam_subnet_id) DO NOTHING RETURNING id`,
          [ourSubnetId, ip, version, a.hostname || null, a.description || null, mac, a.owner || null, status, a.note || null, isGateway, lastSeen]
        );
        if (rows[0]) {
          counts.addresses++;
          if (isGateway) gatewayCandidate.set(ourSubnetId, ip);
          if (sample.addresses.length < 5) sample.addresses.push({ ip, hostname: a.hostname, status });
        } else {
          counts.addressesSkipped++;
        }
      } catch (e) {
        counts.addressesSkipped++;
        warnings.push(`Address ${ip}: ${e.message}`);
      }
    }

    // Backfill subnet gateway from whichever address was flagged is_gateway
    for (const [subnetUuid, ip] of gatewayCandidate) {
      await client.query('UPDATE ipam_subnets SET gateway = $1 WHERE id = $2 AND gateway IS NULL', [ip, subnetUuid]);
    }

    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');

    return { committed: !!commit, counts, warnings, sample };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { run, intToIp, parseValuesTuples };
