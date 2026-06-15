/**
 * Network controller adapter factory.
 * Each adapter exports { fetchClients(config), testConnection(config), vendor }
 */

const adapters = {
  unifi:   require('./unifi'),
  meraki:  require('./meraki'),
  aruba:   require('./aruba'),
  ruckus:  require('./ruckus'),
};

function getAdapter(vendor) {
  const a = adapters[vendor?.toLowerCase()];
  if (!a) throw new Error(`Unknown network vendor: ${vendor}. Supported: ${Object.keys(adapters).join(', ')}`);
  return a;
}

module.exports = { getAdapter, VENDORS: Object.keys(adapters) };
