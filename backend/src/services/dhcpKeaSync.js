// Rebuilds Kea's entire subnet4 list (reservations embedded per-subnet) from
// Postgres and pushes it via config-set/config-write — see kea.js for why
// this replaces incremental subnet4-add/reservation-add (those need
// commercial-only hooks we don't have).
//
// Run on every subnet/reservation CRUD AND on a schedule: config-set is
// runtime-only and config-write only persists inside the container's own
// filesystem, so any Kea container restart/recreate reverts to the static
// on-disk template (empty subnet4) until this runs again. The periodic
// schedule makes that self-healing instead of depending on an admin
// remembering to click "Sync to Kea".
const { pool } = require('../db');
const kea = require('./kea');

async function run() {
  const { rows: subnets } = await pool.query('SELECT * FROM dhcp_subnets WHERE is_active = true');
  const { rows: globalOpts } = await pool.query(
    `SELECT * FROM dhcp_options WHERE scope='global' AND is_active=true`
  );
  const { rows: allReservations } = await pool.query('SELECT * FROM dhcp_reservations');

  const subnet4 = [];
  for (const subnet of subnets) {
    const { rows: subnetOpts } = await pool.query(
      `SELECT * FROM dhcp_options WHERE scope='subnet' AND dhcp_subnet_id=$1 AND is_active=true`,
      [subnet.id]
    );
    const subnetNames = new Set(subnetOpts.map(o => o.option_name));
    const merged = [...subnetOpts, ...globalOpts.filter(o => !subnetNames.has(o.option_name))];
    const reservations = allReservations.filter(r => r.subnet_id === subnet.id);
    subnet4.push(kea.dbRowToKeaSubnet(subnet, merged, reservations));
  }

  await kea.applySubnets(subnet4);
  return { subnets: subnets.length, reservations: allReservations.length };
}

module.exports = { run };
