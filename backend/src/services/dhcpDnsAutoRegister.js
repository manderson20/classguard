// DHCP-lease → DNS auto-registration — the ClassGuard equivalent of what
// Windows AD-integrated DNS does when a domain-joined PC pulls a lease: the
// hostname becomes resolvable automatically, no manual DNS entry needed.
//
// Polls Kea's active leases (lease4-get-all, via the lease_cmds hook) every
// run and reconciles them into a single admin-chosen DNS zone as A records.
// Reconciliation (not just upsert) matters here: a lease's IP changes on
// renewal, so stale auto-registered records for the old IP need to go away,
// not just accumulate — but only records *this job* created (auto_registered
// = true) are ever touched, so anything an admin entered by hand is safe.
//
// Opt-in via settings (dns.dhcp_auto_register / dns.dhcp_auto_register_zone_id)
// since this changes live DNS resolution behavior on an already-running system.

const { query } = require('../db');
const kea = require('./kea');
const { rebuildCache } = require('./localDnsCache');

// Windows clients sometimes send the FQDN as the lease hostname — keep only
// a syntactically valid single DNS label so it can't corrupt the zone.
function sanitizeLabel(hostname, zoneName) {
  if (!hostname) return null;
  let label = hostname.trim().toLowerCase();
  const suffix = `.${zoneName.toLowerCase()}`;
  if (label.endsWith(suffix)) label = label.slice(0, -suffix.length);
  label = label.split('.')[0]; // still has another domain suffix — not ours, take the host part only
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  return label;
}

async function run() {
  const { rows: settingRows } = await query(
    "SELECT key, value FROM settings WHERE key IN ('dns.dhcp_auto_register','dns.dhcp_auto_register_zone_id')"
  );
  const settings = Object.fromEntries(settingRows.map(r => [r.key, r.value]));
  if (settings['dns.dhcp_auto_register'] !== 'true') return { skipped: 'disabled' };

  const zoneId = settings['dns.dhcp_auto_register_zone_id'];
  if (!zoneId) return { skipped: 'no zone configured' };

  const { rows: [zone] } = await query('SELECT id, name FROM dns_zones WHERE id = $1 AND is_active = true', [zoneId]);
  if (!zone) return { skipped: 'configured zone not found or inactive' };

  let leases;
  try {
    leases = await kea.getLeases();
  } catch (e) {
    return { error: `Kea unavailable: ${e.message}` };
  }

  // state 0 = active/valid in Kea's lease4 model; anything else (declined,
  // expired-reclaimed) shouldn't keep a DNS entry.
  const desired = new Map(); // label -> ip
  for (const lease of leases) {
    if (lease.state !== 0) continue;
    const label = sanitizeLabel(lease.hostname, zone.name);
    const ip = lease['ip-address'];
    if (!label || !ip) continue;
    desired.set(label, ip);
  }

  const { rows: existing } = await query(
    `SELECT id, name, value FROM dns_zone_records WHERE zone_id = $1 AND type = 'A' AND auto_registered = true`,
    [zone.id]
  );

  let created = 0, updated = 0, removed = 0;

  for (const rec of existing) {
    const wantIp = desired.get(rec.name);
    if (!wantIp) {
      await query('DELETE FROM dns_zone_records WHERE id = $1', [rec.id]);
      removed++;
    } else if (wantIp !== rec.value) {
      await query('UPDATE dns_zone_records SET value = $1, updated_at = NOW() WHERE id = $2', [wantIp, rec.id]);
      updated++;
    }
    desired.delete(rec.name);
  }

  for (const [label, ip] of desired) {
    await query(
      `INSERT INTO dns_zone_records (zone_id, name, type, value, ttl, auto_registered)
       VALUES ($1,$2,'A',$3,300,true)
       ON CONFLICT (zone_id, name, type, value) DO NOTHING`,
      [zone.id, label, ip]
    );
    created++;
  }

  if (created || updated || removed) await rebuildCache();

  return { zone: zone.name, leasesSeen: leases.length, created, updated, removed };
}

module.exports = { run, sanitizeLabel };
