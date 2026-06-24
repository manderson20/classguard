// Upstream internet/DNS connectivity monitoring — for a district running
// without a separate NMS (Zabbix etc.) to get a basic answer to "is the
// problem our DNS resolution, or the internet connection itself being
// down," without needing to dig through container logs. Built after a real
// incident where this host's own outbound DNS to api.github.com was
// intermittently failing (see CHANGELOG 0.7.7) and there was no record of
// it anywhere — this gives that a home.
const dns  = require('dns');
const net  = require('net');
const { query } = require('../db');
const config     = require('../config');
const events     = require('../events');
const mailer     = require('./mailer');

// Raw-IP literals, never resolved by name — deliberately decoupled from DNS
// so a failure here means "the internet connection itself is the problem,"
// not "DNS is the problem." Two different providers' anycast networks so a
// single provider's outage doesn't look like a local internet outage.
const IP_CHECK_TARGETS = ['1.1.1.1', '8.8.8.8'];
const IP_CHECK_PORT    = 443;
const IP_CHECK_TIMEOUT_MS = 4000;

// Real domain, not a synthetic one — exercises the literal same resolution
// path a student's device depends on.
const DNS_CHECK_DOMAIN  = 'google.com';
const DNS_CHECK_TIMEOUT_MS = 4000;

const CONSECUTIVE_FAILURES_TO_ALERT = 3; // ~6 min at the 2-min poll interval
const RETENTION_DAYS = 90;

async function getUpstreamDnsServers() {
  const { rows } = await query(
    `SELECT value FROM settings WHERE key = 'dns.upstream_ipv4'`
  );
  const list = (rows[0]?.value || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : [config.dns.upstreamPrimary, config.dns.upstreamSecondary].filter(Boolean);
}

function resolveViaServer(server, domain) {
  return new Promise((resolve, reject) => {
    const resolver = new dns.Resolver({ timeout: DNS_CHECK_TIMEOUT_MS, tries: 1 });
    resolver.setServers([server]);
    const start = Date.now();
    resolver.resolve4(domain, (err) => {
      if (err) return reject(err);
      resolve(Date.now() - start);
    });
  });
}

// Tries each configured upstream resolver in order (same failover order
// dns-engine's own upstream.js uses) — succeeds on the first one that
// answers, so a working secondary resolver doesn't look like an outage.
async function checkDns() {
  const servers = await getUpstreamDnsServers();
  let lastErr;
  for (const server of servers) {
    try {
      const latencyMs = await resolveViaServer(server, DNS_CHECK_DOMAIN);
      return { ok: true, server, latencyMs };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, server: servers[servers.length - 1] || null, error: (lastErr || new Error('No upstream resolvers configured')).message };
}

function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port });
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(timeoutMs, () => fail(new Error('connection timed out')));
    socket.once('error', fail);
    socket.once('connect', () => { const latencyMs = Date.now() - start; socket.end(); resolve(latencyMs); });
  });
}

// Tries each raw-IP target in order, succeeds on the first reachable one.
async function checkIp() {
  let lastErr;
  for (const target of IP_CHECK_TARGETS) {
    try {
      const latencyMs = await tcpConnect(target, IP_CHECK_PORT, IP_CHECK_TIMEOUT_MS);
      return { ok: true, target, latencyMs };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, target: IP_CHECK_TARGETS[IP_CHECK_TARGETS.length - 1], error: (lastErr || new Error('no targets configured')).message };
}

// Streak is derived from the persisted history, not in-process state — this
// host restarts the API container often (node --watch on every source
// edit), and in-memory counters would either spam a fresh alert after every
// restart or silently lose a real streak. Looking at the last N rows is
// stateless and survives restarts correctly.
async function checkAlertable(column) {
  const { rows } = await query(
    `SELECT ${column} AS ok FROM internet_health_checks ORDER BY checked_at DESC LIMIT $1`,
    [CONSECUTIVE_FAILURES_TO_ALERT]
  );
  if (rows.length < CONSECUTIVE_FAILURES_TO_ALERT) return { justCrossedDown: false, justRecovered: false };

  const allDown = rows.every(r => r.ok === false);
  if (allDown) {
    // Fire exactly once per outage — on the row that completes the streak,
    // not on every failure after it.
    return { justCrossedDown: true, justRecovered: false };
  }

  // Recovered: current (first) row is healthy, but there was a real prior
  // outage (every other row in the window was down) — not just one blip.
  const [current, ...rest] = rows;
  if (current.ok === true && rest.length && rest.every(r => r.ok === false)) {
    return { justCrossedDown: false, justRecovered: true };
  }
  return { justCrossedDown: false, justRecovered: false };
}

async function sendAlert({ kind, detail }) {
  const subject = kind === 'down'
    ? `[ClassGuard] Upstream ${detail.what} appears to be down`
    : `[ClassGuard] Upstream ${detail.what} has recovered`;
  const text = kind === 'down'
    ? `ClassGuard has detected ${CONSECUTIVE_FAILURES_TO_ALERT} consecutive failed checks for ${detail.what}.\n\nLatest error: ${detail.error || 'n/a'}\n\nCheck the Internet Health widget on the Admin Dashboard for history.`
    : `ClassGuard's ${detail.what} check has recovered after a prior outage.`;

  events.emit('system:internet_alert', { kind, what: detail.what, error: detail.error || null, at: new Date().toISOString() });

  // Best-effort — if this is a DNS-down alert, the SMTP host itself may also
  // be unresolvable, so email isn't guaranteed to arrive in exactly the
  // scenario it matters most. The in-app banner above has no such
  // dependency since it's pushed over an already-open socket connection.
  const cfg = await mailer.getSmtpSettings();
  const recipients = (cfg.safety_alert_emails || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length || !cfg.smtp_host) return;
  try {
    await mailer.sendMail({ to: recipients.join(','), subject, text });
  } catch (err) {
    console.error('[internet-health] alert email failed (expected if DNS itself is down):', err.message);
  }
}

async function runCheck() {
  const [dnsResult, ipResult] = await Promise.all([checkDns(), checkIp()]);

  await query(
    `INSERT INTO internet_health_checks
       (dns_ok, dns_server, dns_latency_ms, dns_error, ip_ok, ip_target, ip_latency_ms, ip_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      dnsResult.ok, dnsResult.server || null, dnsResult.latencyMs || null, dnsResult.error || null,
      ipResult.ok, ipResult.target || null, ipResult.latencyMs || null, ipResult.error || null,
    ]
  );

  const [dnsAlert, ipAlert] = await Promise.all([checkAlertable('dns_ok'), checkAlertable('ip_ok')]);
  if (dnsAlert.justCrossedDown)  await sendAlert({ kind: 'down',      detail: { what: 'DNS resolution', error: dnsResult.error } });
  if (dnsAlert.justRecovered)    await sendAlert({ kind: 'recovered', detail: { what: 'DNS resolution' } });
  if (ipAlert.justCrossedDown)   await sendAlert({ kind: 'down',      detail: { what: 'internet connectivity', error: ipResult.error } });
  if (ipAlert.justRecovered)     await sendAlert({ kind: 'recovered', detail: { what: 'internet connectivity' } });

  return { dns: dnsResult, ip: ipResult };
}

async function pruneOldChecks() {
  await query(`DELETE FROM internet_health_checks WHERE checked_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`);
}

module.exports = { runCheck, pruneOldChecks, checkDns, checkIp };
