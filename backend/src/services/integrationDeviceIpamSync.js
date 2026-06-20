// Maps MDM/inventory-managed devices (Mosyle, Google Admin/ChromeOS) into
// IPAM — but only when there's actually something to register.
//
// Students and staff take laptops/Chromebooks/iPads home, where they get a
// home-router IP that has nothing to do with our network. A device's
// last-known IP (or, for Chromebooks, a *public* WAN IP reported by the home
// router) being absent from our documented subnets isn't a data problem to
// fix — it's the expected, correct state for an offsite device. So unlike
// dhcpLeaseIpamSync.js this job never creates a "ghost" IPAM row for an
// unmatched address: a device only gets linked when one of its known IPs
// falls inside a subnet we've actually documented in IPAM (longest-prefix
// match, same approach as ipamSync.js for network-controller-discovered
// clients). If none match, the device is presumably offsite — skipped
// entirely, every run, with no error and no stale record left behind.
//
// Existing documentation always wins: only fields that are still blank get
// filled in, and address_status (static/reserved/leased) is never touched —
// this is enrichment, not a replacement for DHCP/admin-sourced truth.

const { query } = require('../db');

function deviceTypeFor(osType) {
  if (!osType) return null;
  return osType.toLowerCase();
}

async function syncSource(source, tag) {
  const { rows: devices } = await query(
    `SELECT * FROM integration_devices WHERE source = $1 AND array_length(ip_addresses, 1) > 0`,
    [source]
  );

  let linked = 0, skippedOffsite = 0;

  for (const d of devices) {
    const mac = (d.mac_addresses || []).find(Boolean) || null;
    const owner = d.assigned_email || d.assigned_user || null;
    let matchedAny = false;

    for (const ip of d.ip_addresses || []) {
      if (!ip) continue;
      // Excludes parent/container subnets (e.g. a phpIPAM-style 10.0.0.0/8
      // folder with real /24s nested under it) from matching — every private
      // IP technically falls inside 10.0.0.0/8, so without this a home
      // router's address would wrongly "match" just because it's RFC1918,
      // exactly the false-positive this job exists to avoid. Only a leaf
      // subnet (no children) represents an actual deployed network segment.
      const { rows: [subnetMatch] } = await query(
        `SELECT s.id FROM ipam_subnets s
         WHERE $1::inet <<= s.subnet
           AND NOT EXISTS (SELECT 1 FROM ipam_subnets c WHERE c.parent_id = s.id)
         ORDER BY masklen(s.subnet) DESC LIMIT 1`,
        [ip]
      ).catch(() => ({ rows: [] })); // not a valid inet (e.g. malformed) — skip this IP

      if (!subnetMatch) continue;
      matchedAny = true;

      await query(
        `INSERT INTO ip_addresses
           (ipam_subnet_id, ip, hostname, mac_address, owner, device_type, notes, tags, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'used')
         ON CONFLICT (ip) DO UPDATE SET
           hostname    = COALESCE(NULLIF(ip_addresses.hostname, ''), EXCLUDED.hostname),
           mac_address = COALESCE(ip_addresses.mac_address, EXCLUDED.mac_address),
           owner       = COALESCE(NULLIF(ip_addresses.owner, ''), EXCLUDED.owner),
           device_type = COALESCE(ip_addresses.device_type, EXCLUDED.device_type),
           tags        = CASE WHEN $9 = ANY(ip_addresses.tags) THEN ip_addresses.tags ELSE array_append(ip_addresses.tags, $9) END`,
        [subnetMatch.id, ip, d.device_name, mac, owner, deviceTypeFor(d.os_type),
         `Synced from ${tag === 'mosyle' ? 'Mosyle MDM' : 'Google Admin'}`, [tag], tag]
      );
      linked++;
    }

    if (!matchedAny) skippedOffsite++;
  }

  return { devices: devices.length, linked, skippedOffsite };
}

async function run() {
  const mosyle = await syncSource('mosyle', 'mosyle');
  const google = await syncSource('google_admin', 'google-admin');
  return { mosyle, google };
}

module.exports = { run, syncSource };
