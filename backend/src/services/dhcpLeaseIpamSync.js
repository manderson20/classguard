// DHCP active lease -> IPAM sync — mirrors dhcpDnsAutoRegister.js's
// reconcile-against-Kea pattern, but targets ip_addresses instead of DNS
// records: while a dynamic (non-reservation) lease is active, the IPAM
// address table should show who currently holds that IP and until when.
//
// Three address_status values coexist on ip_addresses:
//   static   - documented by an admin, or no DHCP activity has touched it
//   reserved - a fixed dhcp_reservations row exists (set by dhcpIpamSync.js)
//   leased   - currently handed out via a dynamic (non-reservation) lease
//
// 'reserved' always wins over 'leased' — a reservation is a guaranteed
// assignment, so it stays the documented status even while that IP is
// actively leased. lease_managed marks rows this job is allowed to revert
// or delete once a lease ends; it's never set on reservation-backed rows,
// and routes/ipam.js clears it the moment an admin hand-edits a row, so we
// never clobber documentation a human typed in.

const { query } = require('../db');
const kea = require('./kea');

async function run() {
  let leases;
  try {
    leases = await kea.getLeases();
  } catch (e) {
    return { error: `Kea unavailable: ${e.message}` };
  }

  // state 0 = active/valid; expired-reclaimed/declined leases shouldn't
  // keep an IPAM address marked as leased.
  const active = leases.filter(l => l.state === 0 && l['ip-address']);

  let created = 0, updated = 0, reverted = 0, deleted = 0;
  const seenIps = new Set();

  for (const lease of active) {
    const ip = lease['ip-address'];
    seenIps.add(ip);
    const mac = lease['hw-addr'] || null;
    const hostname = lease.hostname || null;
    const expiresAt = lease.expire ? new Date(lease.expire * 1000) : null;

    const { rows: [existing] } = await query('SELECT * FROM ip_addresses WHERE ip = $1', [ip]);

    if (!existing) {
      // Longest-prefix-match against documented IPAM subnets — same
      // approach as ipamSync.js for network-controller-discovered clients.
      const { rows: [subnetMatch] } = await query(
        `SELECT id FROM ipam_subnets WHERE $1::inet <<= subnet ORDER BY masklen(subnet) DESC LIMIT 1`,
        [ip]
      );
      if (!subnetMatch) continue; // no documented subnet covers this IP — nothing to attach the row to

      await query(
        `INSERT INTO ip_addresses
           (ipam_subnet_id, ip, hostname, mac_address, address_status, lease_expires_at, lease_managed, status)
         VALUES ($1,$2,$3,$4,'leased',$5,true,'used')
         ON CONFLICT (ip) DO NOTHING`,
        [subnetMatch.id, ip, hostname, mac, expiresAt]
      );
      created++;
      continue;
    }

    if (existing.address_status === 'reserved') continue; // reservation stays authoritative

    await query(
      `UPDATE ip_addresses SET
         address_status   = 'leased',
         lease_expires_at = $2,
         mac_address       = COALESCE(mac_address, $3),
         hostname           = COALESCE(NULLIF(hostname, ''), $4)
       WHERE id = $1`,
      [existing.id, expiresAt, mac, hostname]
    );
    updated++;
  }

  // Reconcile: rows we previously marked 'leased' whose lease is gone (expired
  // or moved to a different IP) revert to 'static', or get deleted entirely if
  // nothing else ever documented them (lease_managed=true means this job is
  // the sole author of that row's existence).
  const { rows: stale } = await query(
    `SELECT id, lease_managed FROM ip_addresses WHERE address_status = 'leased' AND ip != ALL($1::inet[])`,
    [active.length ? Array.from(seenIps) : ['0.0.0.0']]
  );

  for (const row of stale) {
    // lease_managed=true rows exist solely because this job created them —
    // once the lease ends there's nothing else documenting that address, so
    // delete it rather than leaving a stale ghost entry. lease_managed=false
    // means the row predates (or was claimed by an admin edit after) this
    // job, e.g. CSV-imported or hand-documented — just drop the lease info.
    if (row.lease_managed) {
      await query('DELETE FROM ip_addresses WHERE id = $1', [row.id]);
      deleted++;
    } else {
      await query(
        `UPDATE ip_addresses SET address_status = 'static', lease_expires_at = NULL WHERE id = $1`,
        [row.id]
      );
      reverted++;
    }
  }

  return { leasesSeen: active.length, created, updated, reverted, deleted };
}

module.exports = { run };
