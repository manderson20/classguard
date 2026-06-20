// Shared create/delete logic for DHCP reservations — used by both
// routes/dhcp.js (DHCP module's Reservations tab) and routes/ipam.js
// ("Reserve for DHCP" action on an IPAM address), so a reservation made from
// either screen behaves identically: pool-range validated, pushed live to
// Kea, and reflected into ip_addresses as address_status='reserved'.
const { pool } = require('../db');
const dhcpKeaSync = require('./dhcpKeaSync');
const dhcpIpamSync = require('./dhcpIpamSync');

async function ipInPool(ip, poolStart, poolEnd) {
  const { rows } = await pool.query(
    `SELECT ($1::inet >= $2::inet AND $1::inet <= $3::inet) AS ok`,
    [ip, poolStart, poolEnd]
  );
  return rows[0]?.ok === true;
}

async function createReservation({ subnetId, macAddress, ipAddress, hostname, deviceId, notes, userId }) {
  const { rows: [subnet] } = await pool.query('SELECT * FROM dhcp_subnets WHERE id = $1', [subnetId]);
  if (!subnet) throw Object.assign(new Error('Subnet not found'), { status: 404 });

  const inPool = await ipInPool(ipAddress, subnet.pool_start, subnet.pool_end);
  if (!inPool) {
    throw Object.assign(new Error(`IP ${ipAddress} is not within pool ${subnet.pool_start}–${subnet.pool_end}`), { status: 400 });
  }

  const mac = macAddress.toLowerCase();

  let row;
  try {
    const { rows } = await pool.query(
      `INSERT INTO dhcp_reservations
         (subnet_id, mac_address, ip_address, hostname, device_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [subnetId, mac, ipAddress, hostname ?? null, deviceId ?? null, notes ?? null, userId]
    );
    row = rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw Object.assign(new Error('Reservation already exists for that MAC or IP in this subnet'), { status: 409 });
    }
    throw err;
  }

  try { await dhcpKeaSync.run(); } catch (kerr) {
    console.warn('[dhcp-reservations] Kea sync failed:', kerr.message);
  }
  try { await dhcpIpamSync.syncReservationToIpam(row); } catch (ierr) {
    console.warn('[dhcp-reservations] IPAM syncReservation failed:', ierr.message);
  }

  return row;
}

async function deleteReservation(id) {
  const { rows } = await pool.query('SELECT * FROM dhcp_reservations WHERE id = $1', [id]);
  if (!rows.length) throw Object.assign(new Error('Reservation not found'), { status: 404 });

  // Must run before the DELETE below — the FK's ON DELETE SET NULL would
  // otherwise sever the link before this can find the row to clean up.
  try { await dhcpIpamSync.removeReservationFromIpam(id); } catch (ierr) {
    console.warn('[dhcp-reservations] IPAM removeReservation failed:', ierr.message);
  }

  await pool.query('DELETE FROM dhcp_reservations WHERE id = $1', [id]);
  // Run after the delete — the rebuild reads current DB state.
  try { await dhcpKeaSync.run(); } catch (kerr) {
    console.warn('[dhcp-reservations] Kea sync failed:', kerr.message);
  }

  return rows[0];
}

module.exports = { createReservation, deleteReservation, ipInPool };
