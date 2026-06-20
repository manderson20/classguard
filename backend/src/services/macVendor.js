// MAC vendor (OUI) lookup.
//
// backend/src/data/oui.json is a small, hand-curated seed list — not the
// full IEEE registry (this server has no outbound internet access to fetch
// https://standards-oui.ieee.org/oui/oui.txt). For full coverage, download
// that file and convert it to the same { "AABBCC": "Vendor Name" } JSON
// shape (uppercase hex, no separators), then replace oui.json — no code
// changes needed, lookupVendor() just reads whatever's in the file.

const oui = require('../data/oui.json');

function lookupVendor(mac) {
  if (!mac) return null;
  const prefix = mac.replace(/[:.-]/g, '').toUpperCase().slice(0, 6);
  if (prefix.length < 6) return null;
  return oui[prefix] || null;
}

module.exports = { lookupVendor };
