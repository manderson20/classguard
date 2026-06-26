// Rebuilds Kea's entire subnet6 list from Postgres and pushes it via
// config-set/config-write. Same pattern and reasoning as dhcpKeaSync.js —
// config-set is runtime-only, so every Kea restart reverts to the empty
// template; periodic scheduling makes that self-healing.
const { pool } = require('../db');
const kea = require('./kea');

async function run() {
  const { rows: subnets } = await pool.query('SELECT * FROM dhcp_subnets_v6 WHERE is_active = true');
  const { rows: globalOpts } = await pool.query(
    `SELECT * FROM dhcp_options_v6 WHERE scope='global' AND is_active=true`
  );
  const { rows: allReservations } = await pool.query('SELECT * FROM dhcp_reservations_v6');

  const subnet6 = [];
  for (const subnet of subnets) {
    const { rows: subnetOpts } = await pool.query(
      `SELECT * FROM dhcp_options_v6 WHERE scope='subnet' AND dhcp_subnet_id=$1 AND is_active=true`,
      [subnet.id]
    );
    const subnetNames = new Set(subnetOpts.map(o => o.option_name));
    const merged = [...subnetOpts, ...globalOpts.filter(o => !subnetNames.has(o.option_name))];
    const reservations = allReservations.filter(r => r.subnet_id === subnet.id);
    subnet6.push(kea.dbRowToKeaSubnet6(subnet, merged, reservations));
  }

  await kea.applySubnets6(subnet6);
  return { subnets: subnets.length, reservations: allReservations.length };
}

module.exports = { run };
