// ipamSync.js — bridge network_clients → ip_addresses (IPAM)
// Called after each controller sync and on a 15-minute schedule.

const { query } = require('../db');

async function syncNetworkClientsToIpam() {
  // For each network client with a valid IP, find the most-specific IPAM subnet
  // that contains it, then upsert into ip_addresses.
  const { rows: matches } = await query(`
    SELECT DISTINCT ON (nc.id)
      nc.id          AS client_id,
      nc.ip_address,
      nc.mac,
      nc.hostname,
      nc.last_seen,
      nc.vendor_oui,
      nc.os_type,
      nc.connection_type,
      nc.vlan,
      s.id           AS ipam_subnet_id
    FROM network_clients nc
    JOIN ipam_subnets s ON nc.ip_address <<= s.subnet
    WHERE nc.ip_address IS NOT NULL
    ORDER BY nc.id, masklen(s.subnet) DESC
  `);

  let created = 0, updated = 0, errors = 0;

  for (const m of matches) {
    try {
      const deviceType = m.connection_type === 'wireless'
        ? 'wireless'
        : (m.os_type || null);

      // Conflict target is `ip` alone, not `(ip, ipam_subnet_id)` — `ip_addresses`
      // carries two overlapping unique constraints (the original column-level
      // UNIQUE on `ip` from migration 005, plus a composite one on
      // `(ip, ipam_subnet_id)` added in migration 017 specifically so this
      // query's ON CONFLICT would work). Targeting the composite constraint
      // meant a genuine, recurring failure mode: if the most-specific IPAM
      // subnet resolved for an IP ever changes between sync runs (a new,
      // more-specific subnet gets created, or an existing one gets edited),
      // this INSERT's ON CONFLICT wouldn't match the *existing* row (still
      // under the old ipam_subnet_id) and would instead hit the older, wider
      // `ip` UNIQUE constraint — a raw, uncaught-by-ON-CONFLICT duplicate-key
      // error, permanently, on every 15-minute sync, since nothing ever
      // updated the stale row. Targeting `ip` (the real invariant — a given
      // IP maps to one row, one current subnet) and updating
      // `ipam_subnet_id` on conflict lets a device's subnet mapping
      // self-correct instead.
      const { rows: [row] } = await query(`
        INSERT INTO ip_addresses
          (ip, ipam_subnet_id, hostname, mac_address, status, last_seen, device_type, owner)
        VALUES ($1::inet, $2, $3, $4::macaddr, 'used', $5, $6, $7)
        ON CONFLICT (ip) DO UPDATE SET
          ipam_subnet_id = EXCLUDED.ipam_subnet_id,
          last_seen   = EXCLUDED.last_seen,
          hostname    = COALESCE(NULLIF(ip_addresses.hostname, ''), EXCLUDED.hostname),
          mac_address = COALESCE(ip_addresses.mac_address,   EXCLUDED.mac_address),
          device_type = COALESCE(ip_addresses.device_type,   EXCLUDED.device_type),
          status      = CASE
                          WHEN ip_addresses.status IN ('reserved', 'offline') THEN ip_addresses.status
                          ELSE 'used'
                        END
        RETURNING id, (xmax = 0) AS is_new
      `, [
        m.ip_address,
        m.ipam_subnet_id,
        m.hostname || null,
        m.mac || null,
        m.last_seen,
        deviceType,
        m.vendor_oui || null,
      ]);

      if (row?.is_new) created++; else updated++;
    } catch (e) {
      errors++;
      // Don't let one bad row abort the whole sync
      console.error(`[ipam-sync] ${m.ip_address}:`, e.message);
    }
  }

  console.log(`[ipam-sync] done — created:${created} updated:${updated} errors:${errors} total_clients:${matches.length}`);
  return { created, updated, errors, total: matches.length };
}

module.exports = { syncNetworkClientsToIpam };
