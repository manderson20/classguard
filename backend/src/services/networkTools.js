// On-demand diagnostics for whichever node actually serves the request --
// ping, traceroute, and "what public IP does our own outbound traffic show
// up as" (useful for confirming what to allowlist on a vendor's end, or
// that failover didn't silently change the apparent source IP). Same
// execFile-with-an-args-array pattern as pingScan.js's fping call: never
// hand user input to a shell, so there's no injection surface no matter
// what a host string contains.
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');

const execFileAsync = promisify(execFile);

// Conservative hostname/IPv4/IPv6 allowlist -- rejects anything that isn't
// plausibly a real target before it ever reaches ping/traceroute, so a
// garbage input fails fast with a clear error instead of a confusing
// binary-level one.
const HOST_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.:_-]{0,253})[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

function assertValidHost(host) {
  if (typeof host !== 'string' || !host.trim() || !HOST_RE.test(host.trim())) {
    throw new Error('Invalid host — use a hostname or IP address');
  }
  return host.trim();
}

async function ping(host, count = 4) {
  const target = assertValidHost(host);
  const n = Math.min(Math.max(parseInt(count, 10) || 4, 1), 10);
  try {
    const { stdout } = await execFileAsync('ping', ['-c', String(n), '-W', '2', target], { timeout: 20_000 });
    return { ok: true, output: stdout };
  } catch (err) {
    // ping exits non-zero on packet loss / unreachable host -- that's a
    // valid (if unwelcome) result, not a tool failure, so still return
    // whatever output it produced.
    return { ok: false, output: err.stdout || err.message };
  }
}

async function traceroute(host) {
  const target = assertValidHost(host);
  try {
    const { stdout } = await execFileAsync('traceroute', ['-w', '2', '-q', '1', '-m', '20', target], { timeout: 30_000 });
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, output: err.stdout || err.message };
  }
}

async function getPublicIp() {
  const { data } = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
  return data.ip;
}

module.exports = { ping, traceroute, getPublicIp, assertValidHost };
