// Bridges dhcp_subnets (what Kea actually serves) and ipam_subnets (what the
// IPAM page reads) — two tables that otherwise never talk to each other.
// Also reflects individual DHCP reservations into ip_addresses so IPAM shows
// an accurate static/reserved/leased status per address.
const { query } = require('../db');

// Find-or-create the matching ipam_subnets row for a dhcp_subnets row,
// matched by exact CIDR. If a phpIPAM-imported subnet already documents
// this network, link it rather than creating a duplicate.
async function syncSubnetToIpam(dhcpSubnet) {
  const { rows: [existing] } = await query('SELECT * FROM ipam_subnets WHERE subnet = $1::cidr', [dhcpSubnet.subnet]);

  if (existing) {
    await query(
      `UPDATE ipam_subnets SET
         dhcp_subnet_id = $1, dhcp_enabled = true, dhcp_pool_start = $2, dhcp_pool_end = $3,
         gateway = COALESCE(gateway, $4),
         dns_servers = CASE WHEN dns_servers IS NULL OR array_length(dns_servers, 1) IS NULL THEN $5 ELSE dns_servers END,
         updated_at = NOW()
       WHERE id = $6`,
      [dhcpSubnet.id, dhcpSubnet.pool_start, dhcpSubnet.pool_end, dhcpSubnet.gateway || null,
       dhcpSubnet.dns_servers || null, existing.id]
    );
    return existing.id;
  }

  const { rows: [created] } = await query(
    `INSERT INTO ipam_subnets (subnet, name, gateway, dns_servers, dhcp_subnet_id, dhcp_enabled, dhcp_pool_start, dhcp_pool_end)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING id`,
    [dhcpSubnet.subnet, dhcpSubnet.label || null, dhcpSubnet.gateway || null, dhcpSubnet.dns_servers || null,
     dhcpSubnet.id, dhcpSubnet.pool_start, dhcpSubnet.pool_end]
  );
  return created.id;
}

// Reflect a DHCP reservation into ip_addresses as address_status='reserved'.
// Never overwrites hostname/owner/notes an admin already typed in — only
// fills those in if blank, since the reservation existing is authoritative
// for *status*, not for documentation text.
async function syncReservationToIpam(reservation) {
  const { rows: [existing] } = await query('SELECT * FROM ip_addresses WHERE ip = $1', [reservation.ip_address]);

  if (!existing) {
    await query(
      `INSERT INTO ip_addresses (ip, hostname, mac_address, address_status, dhcp_reservation_id, is_static)
       VALUES ($1,$2,$3,'reserved',$4,false)
       ON CONFLICT (ip) DO UPDATE SET
         address_status = 'reserved', dhcp_reservation_id = EXCLUDED.dhcp_reservation_id,
         mac_address = COALESCE(ip_addresses.mac_address, EXCLUDED.mac_address)`,
      [reservation.ip_address, reservation.hostname || null, reservation.mac_address, reservation.id]
    );
    return;
  }

  await query(
    `UPDATE ip_addresses SET
       address_status = 'reserved',
       dhcp_reservation_id = $1,
       mac_address = COALESCE(mac_address, $2),
       hostname = COALESCE(hostname, $3)
     WHERE id = $4`,
    [reservation.id, reservation.mac_address, reservation.hostname || null, existing.id]
  );
}

// On reservation delete: the address stays documented in IPAM (it's still a
// known host — un-reserving doesn't mean "forget this IP"), it just drops
// back to 'static' since DHCP no longer guarantees it that address.
async function removeReservationFromIpam(reservationId) {
  await query(
    `UPDATE ip_addresses SET
       address_status = CASE WHEN address_status = 'reserved' THEN 'static' ELSE address_status END,
       dhcp_reservation_id = NULL
     WHERE dhcp_reservation_id = $1`,
    [reservationId]
  );
}

module.exports = { syncSubnetToIpam, syncReservationToIpam, removeReservationFromIpam };
