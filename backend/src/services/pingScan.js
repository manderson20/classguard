// Presence scanning — ICMP sweep of IPAM subnets via fping, mirroring the
// "FPing path" approach phpIPAM itself uses. Populates ip_addresses.ping_status
// and .last_seen so the IPAM UI can show which documented IPs are actually
// online right now. Requires the `api` container to have CAP_NET_RAW and the
// `fping` binary (see docker-compose.yml / backend/Dockerfile).

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { query } = require('../db');

// Skip subnets bigger than a /20 (4096 hosts) so one runaway CIDR can't turn
// a 10-minute cron tick into an hours-long ICMP flood.
const MAX_HOSTS = 4096;

function hostCountFromPrefix(cidr) {
  const m = String(cidr).match(/\/(\d+)$/);
  if (!m) return Infinity;
  return Math.pow(2, 32 - parseInt(m[1], 10));
}

async function scanSubnet(subnetRow) {
  const { id, subnet, ip_version } = subnetRow;
  if (ip_version !== 4) return { scanned: 0, alive: 0, skipped: 'IPv6 sweeps not supported yet' };
  if (hostCountFromPrefix(subnet) > MAX_HOSTS) {
    return { scanned: 0, alive: 0, skipped: 'subnet larger than /20 — skipped to avoid a runaway scan' };
  }

  let stdout = '';
  try {
    const result = await execFileAsync(
      'fping', ['-a', '-q', '-r', '1', '-t', '800', '-g', subnet],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch (err) {
    // fping exits non-zero whenever any host doesn't answer — that's the
    // normal case (most of a subnet is usually free), not a real failure.
    stdout = err.stdout || '';
  }

  const aliveSet = new Set(stdout.split('\n').map(l => l.trim()).filter(Boolean));
  const { rows: known } = await query('SELECT id, ip FROM ip_addresses WHERE ipam_subnet_id = $1', [id]);
  const seenAt = new Date();

  for (const row of known) {
    const online = aliveSet.has(row.ip);
    // $2 reused in two type contexts (varchar column vs text comparison) made
    // Postgres throw "inconsistent types deduced for parameter $2" — pass the
    // CASE condition as its own boolean parameter instead.
    await query(
      `UPDATE ip_addresses
       SET ping_status = $2, last_seen = CASE WHEN $3 THEN $4 ELSE last_seen END
       WHERE id = $1`,
      [row.id, online ? 'online' : 'offline', online, seenAt]
    );
  }

  return { scanned: known.length, alive: aliveSet.size };
}

async function scanAllSubnets() {
  const { rows: subnets } = await query(
    `SELECT id, subnet, ip_version FROM ipam_subnets WHERE scan_enabled = true`
  );
  let scanned = 0, alive = 0;
  for (const s of subnets) {
    try {
      const r = await scanSubnet(s);
      scanned += r.scanned;
      alive   += r.alive;
    } catch (err) {
      console.error(`[ping-scan] subnet ${s.subnet} failed:`, err.message);
    }
  }
  return { subnets: subnets.length, scanned, alive };
}

module.exports = { scanSubnet, scanAllSubnets };
