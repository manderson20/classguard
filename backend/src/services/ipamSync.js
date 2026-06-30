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

      const { rows: [row] } = await query(`
        INSERT INTO ip_addresses
          (ip, ipam_subnet_id, hostname, mac_address, status, last_seen, device_type, owner)
        VALUES ($1::inet, $2, $3, $4::macaddr, 'used', $5, $6, $7)
        ON CONFLICT (ip, ipam_subnet_id) DO UPDATE SET
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
