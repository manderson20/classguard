// Imports one Windows DHCP scope from the files Windows DHCP MMC console
// produces via right-click scope/tab → "Export List": Address Pool,
// Scope Options, Reservations, Leases, and Policies. Each is a separate
// tab-separated text export — the user uploads whichever ones they have for
// one scope at a time.
//
// Windows DHCP scopes don't export their own subnet/mask directly (that's a
// scope *property*, not one of the per-tab list exports) — the CIDR here is
// inferred from the gateway + pool boundaries, which the admin should
// double check against the real scope before relying on it.
//
// Reservations.txt only has [IP] hostname — the MAC comes from cross-
// referencing Leases.txt, where Windows records the reservation's
// "Unique ID" once it's been used at least once.
//
// On commit, the resulting subnet/reservations are pushed live to Kea via
// dhcpKeaSync.run() — same as every other DHCP write in this app
// (routes/dhcp.js) — so this scope starts serving leases immediately.

const { pool } = require('../db');
const dhcpKeaSync = require('./dhcpKeaSync');
const dhcpIpamSync = require('./dhcpIpamSync');

function parseTabFile(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const header = lines[0].split('\t').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split('\t');
    const obj = {};
    header.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
    return obj;
  });
}

// "Reservations" header line, then "[10.10.1.6] EPSONF5C705.yourdistrict.org"
function parseReservationsFile(text) {
  const out = [];
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const m = /^\[([\d.]+)\]\s*(.+)$/.exec(line);
    if (m) out.push({ ip: m[1], hostname: m[2] });
  }
  return out;
}

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function commonPrefixLen(a, b) {
  let diff = (a ^ b) >>> 0, len = 32;
  while (diff !== 0) { diff >>>= 1; len--; }
  return len;
}
// Smallest CIDR block containing every given IP — best-effort substitute for
// the scope's real subnet mask, which Windows doesn't include in these exports.
function inferCidr(ips) {
  const ints = ips.filter(Boolean).map(ipToInt);
  if (!ints.length) return null;
  let prefix = 32;
  for (let i = 1; i < ints.length; i++) prefix = Math.min(prefix, commonPrefixLen(ints[0], ints[i]));
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return `${intToIp((ints[0] & mask) >>> 0)}/${prefix}`;
}

function formatMac(raw) {
  const hex = (raw || '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{1,2}/g).join(':').toUpperCase();
}

async function run({ scopeName, poolText, optionsText, reservationsText, leasesText, policiesText }, commit) {
  if (!scopeName || !scopeName.trim()) throw new Error('A scope name is required');
  const warnings = [];
  const notesParts = [];

  let poolStart = null, poolEnd = null;
  if (poolText) {
    const [row] = parseTabFile(poolText);
    if (row) { poolStart = row['Start IP Address'] || null; poolEnd = row['End IP Address'] || null; }
  }
  if (!poolStart || !poolEnd) throw new Error('Pool file is required (need at least the Start/End IP Address to determine the scope range)');

  let gateway = null, dnsServers = [], domainName = null;
  if (optionsText) {
    for (const o of parseTabFile(optionsText)) {
      const isPolicyScoped = o['Policy Name'] && o['Policy Name'] !== 'None';
      if (isPolicyScoped) {
        notesParts.push(`Policy-scoped option "${o['Option Name']}" = ${o['Value']} (policy: ${o['Policy Name']}) — not imported; set up via Kea client-classes if this PXE/policy behavior is still needed.`);
        continue;
      }
      if (/^003 Router$/i.test(o['Option Name'])) gateway = o['Value'].split(',')[0].trim() || null;
      else if (/^006 DNS Servers$/i.test(o['Option Name'])) dnsServers = o['Value'].split(',').map(s => s.trim()).filter(Boolean);
      else if (/^015 DNS Domain Name$/i.test(o['Option Name'])) domainName = o['Value'].trim() || null;
      else notesParts.push(`Scope option "${o['Option Name']}" = ${o['Value']} — not auto-mapped, add manually under DHCP → Options if needed.`);
    }
  }

  if (policiesText) {
    for (const p of parseTabFile(policiesText)) {
      notesParts.push(`Policy "${p['Policy Name']}": ${p['Description']} (order ${p['Processing Order']}, ${p['State']}) — informational only, not configured in Kea.`);
    }
  }

  const reservations = reservationsText ? parseReservationsFile(reservationsText) : [];
  const macByIp = {};
  if (leasesText) {
    for (const l of parseTabFile(leasesText)) {
      if (l['Unique ID'] && l['Client IP Address']) macByIp[l['Client IP Address']] = l['Unique ID'];
    }
  }

  const cidr = inferCidr([gateway, poolStart, poolEnd]);
  if (!cidr) throw new Error('Could not infer a subnet from the pool range');

  const counts = { reservations: 0, reservationsSkipped: 0 };
  const sample = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let subnetRow;
    const { rows: [existing] } = await client.query('SELECT * FROM dhcp_subnets WHERE subnet = $1::cidr', [cidr]);
    if (existing) {
      const { rows: [updated] } = await client.query(
        `UPDATE dhcp_subnets SET label=$2, pool_start=$3::inet, pool_end=$4::inet, gateway=$5::inet,
            dns_servers=$6::inet[], domain_name=$7, notes=$8, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [existing.id, scopeName, poolStart, poolEnd, gateway, dnsServers.length ? dnsServers : null, domainName, notesParts.join('\n') || null]
      );
      subnetRow = updated;
    } else {
      const { rows: [maxRow] } = await client.query('SELECT COALESCE(MAX(kea_subnet_id), 0) + 1 AS next FROM dhcp_subnets');
      const { rows: [created] } = await client.query(
        `INSERT INTO dhcp_subnets (kea_subnet_id, subnet, label, pool_start, pool_end, gateway, dns_servers, domain_name, notes)
         VALUES ($1,$2::cidr,$3,$4::inet,$5::inet,$6::inet,$7::inet[],$8,$9)
         RETURNING *`,
        [maxRow.next, cidr, scopeName, poolStart, poolEnd, gateway, dnsServers.length ? dnsServers : null, domainName, notesParts.join('\n') || null]
      );
      subnetRow = created;
    }

    const reservationRows = [];
    for (const r of reservations) {
      const macFmt = formatMac(macByIp[r.ip]);
      if (!macFmt) { counts.reservationsSkipped++; warnings.push(`Reservation ${r.ip} (${r.hostname}): no MAC found in the Leases file — skipped`); continue; }

      const sp = `sp_${counts.reservations + counts.reservationsSkipped}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        const { rows: [row] } = await client.query(
          `INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname)
           VALUES ($1,$2::macaddr,$3::inet,$4)
           ON CONFLICT (subnet_id, mac_address) DO UPDATE SET ip_address=EXCLUDED.ip_address, hostname=EXCLUDED.hostname, updated_at=NOW()
           RETURNING *`,
          [subnetRow.id, macFmt, r.ip, r.hostname]
        );
        await client.query(`RELEASE SAVEPOINT ${sp}`);
        counts.reservations++;
        reservationRows.push(row);
        if (sample.length < 5) sample.push({ ip: r.ip, hostname: r.hostname, mac: macFmt });
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        counts.reservationsSkipped++;
        warnings.push(`Reservation ${r.ip}: ${e.message}`);
      }
    }

    if (commit) {
      await client.query('COMMIT');
      try { await dhcpKeaSync.run(); } catch (e) { warnings.push(`Kea sync: ${e.message}`); }
      try { await dhcpIpamSync.syncSubnetToIpam(subnetRow); } catch (e) { warnings.push(`IPAM subnet sync: ${e.message}`); }
      for (const r of reservationRows) {
        try { await dhcpIpamSync.syncReservationToIpam(r); }
        catch (e) { warnings.push(`IPAM reservation sync (${r.ip_address}): ${e.message}`); }
      }
    } else {
      await client.query('ROLLBACK');
    }

    return { committed: !!commit, scopeName, subnet: cidr, counts, warnings, sample, notes: notesParts };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { run, parseTabFile, parseReservationsFile, inferCidr };
