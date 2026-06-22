const cron   = require('node-cron');
const axios  = require('axios');
const redis  = require('../redis');
const { query } = require('../db');
const config = require('../config');
const { syncAll } = require('./blocklistSync');
const { syncNetworkClientsToIpam } = require('./ipamSync');
const { syncAll: syncCategories, classifyRecentDomains } = require('./categoryImport');
const acmeTls   = require('./acmeTls');
const pingScan  = require('./pingScan');
const dhcpDnsAutoRegister = require('./dhcpDnsAutoRegister');
const dhcpKeaSync = require('./dhcpKeaSync');
const dhcpLeaseIpamSync = require('./dhcpLeaseIpamSync');
const integrationDeviceIpamSync = require('./integrationDeviceIpamSync');
const radiusSync = require('./radiusSync');
const ntp = require('./ntp');
const teacherUtilization = require('./teacherUtilization');
const { invalidatePolicy } = require('./policyResolver');
const events = require('../events');
const { syncController } = require('../routes/network');
const { pool } = require('../db');

// ---------------------------------------------------------------------------
// DNS log drain  — every 30 seconds
// Reads entries from the Redis stream 'classguard:dns-log' written by the
// DNS engine and bulk-inserts them into the dns_logs PostgreSQL table.
// ---------------------------------------------------------------------------

const DNS_STREAM  = 'classguard:dns-log';
const CURSOR_KEY  = 'classguard:dns-log:cursor';
// Read up to 50k entries per cycle. At 100 q/s average and 5s interval that's
// 500 entries; 50k handles bursts of up to ~10,000 q/s without backpressure.
const DRAIN_BATCH = 50_000;

function parseStreamEntry(fields) {
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

// Use unnest() arrays — single round-trip regardless of row count, and
// avoids the 65535-parameter limit of $1..$N style inserts. Shared by the
// local drain below and routes/dns.js's /internal/dns-logs/bulk, which a
// standby node forwards into when its own Postgres is a read-only replica.
async function insertDnsLogBatch(records) {
  const userIds          = records.map(r => r.studentId        || null);
  const deviceIds        = records.map(r => r.deviceId         || null);
  const lessonSessionIds = records.map(r => r.lessonSessionId  || null);
  const domains          = records.map(r => r.domain           || '');
  const actions          = records.map(r => r.action           || 'allowed');
  const blockReasons     = records.map(r => r.blockReason      || null);
  const sourceIps        = records.map(r => r.sourceIp          || null);
  const queriedAts       = records.map(r =>
    r.timestamp ? new Date(parseInt(r.timestamp, 10)) : new Date()
  );

  await query(
    `INSERT INTO dns_logs (user_id, device_id, lesson_session_id, domain, action, block_reason, source_ip, queried_at)
     SELECT * FROM unnest(
       $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::inet[], $8::timestamptz[]
     )
     ON CONFLICT DO NOTHING`,
    [userIds, deviceIds, lessonSessionIds, domains, actions, blockReasons, sourceIps, queriedAts]
  );
}

// Lazily mirrors this node's own INTERNAL_SECRET into the (replicated)
// settings table — only ever called on the primary, since that's the only
// node that can write. A standby reads this same row back from its local
// read-only replica to authenticate calls it forwards to the primary,
// with zero manual credential-sharing step between the two servers.
let secretSeeded = false;
async function ensureInternalSecretSeeded() {
  if (secretSeeded || config.node.role !== 'primary') return;
  await query(
    `INSERT INTO settings (key, value) VALUES ('internal_secret', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [process.env.INTERNAL_SECRET || '']
  ).catch(() => {});
  secretSeeded = true;
}

// On a standby, this node's own local Postgres is a read-only streaming
// replica — writing dns_logs here would fail every time. Forward the batch
// to whichever node the (replicated) `nodes` table says is currently
// primary instead, so query history from a standby that's actively serving
// DNS still lands in one shared table rather than being silently dropped.
async function insertOrForwardDnsLogs(records) {
  await ensureInternalSecretSeeded();

  const { rows: [{ in_recovery }] } = await query('SELECT pg_is_in_recovery() AS in_recovery');
  if (!in_recovery) {
    return insertDnsLogBatch(records);
  }

  const { rows: [primary] } = await query(
    `SELECT api_url FROM nodes WHERE ha_role = 'primary' AND is_active ORDER BY last_seen DESC LIMIT 1`
  );
  const { rows: [secretRow] } = await query(`SELECT value FROM settings WHERE key = 'internal_secret'`);
  if (!primary?.api_url || !secretRow?.value) {
    throw new Error('cannot forward dns logs to primary — node/secret not found in replicated data yet');
  }

  await axios.post(`${primary.api_url}/api/v1/dns/internal/dns-logs/bulk`, { records }, {
    headers: { 'x-internal-secret': secretRow.value },
    timeout: 8000,
  });
}

async function drainDnsLog() {
  let cursor = (await redis.get(CURSOR_KEY)) || '0';
  let total  = 0;

  // Drain loop — keep reading until the stream is empty so we don't fall behind
  while (true) {
    const result = await redis.xread('COUNT', DRAIN_BATCH, 'STREAMS', DNS_STREAM, cursor);
    if (!result || result.length === 0) break;

    const [, entries] = result[0];
    if (!entries || entries.length === 0) break;

    const records = entries.map(([id, fields]) => ({ id, ...parseStreamEntry(fields) }));

    await insertOrForwardDnsLogs(records);

    cursor = entries[entries.length - 1][0];
    total += entries.length;

    // Trim already-consumed entries from the stream
    await redis.xtrim(DNS_STREAM, 'MINID', cursor).catch(() => {});

    if (entries.length < DRAIN_BATCH) break; // caught up
  }

  if (total > 0) {
    await redis.set(CURSOR_KEY, cursor);
  }
}

// ---------------------------------------------------------------------------
// Browser history drain — every 5 seconds
// Reads tab-navigation events from the Redis stream 'classguard:tab-events'
// (written by routes/extension.js's /tab-event, which also still emits the
// existing live-teacher-view socket event) and bulk-inserts them into
// browser_history. That stream already existed for the live view but was
// never drained anywhere durable — capped at ~50k entries, oldest dropped.
// Mirrors the DNS log drain above exactly, including the HA forward-to-
// primary behavior on a standby node.
// ---------------------------------------------------------------------------

const TAB_STREAM        = 'classguard:tab-events';
const TAB_CURSOR_KEY     = 'classguard:tab-events:cursor';
const TAB_DRAIN_BATCH    = 10_000;

async function insertBrowserHistoryBatch(records) {
  const userIds          = records.map(r => r.student_id        || null);
  const deviceIds        = records.map(r => r.device_id         || null);
  const lessonSessionIds = records.map(r => r.lesson_session_id || null);
  const urls             = records.map(r => r.url               || '');
  const titles           = records.map(r => r.title             || null);
  const actions          = records.map(r => r.action            || null);
  const blockReasons     = records.map(r => r.block_reason      || null);
  const isDirectIps      = records.map(r => r.is_direct_ip === '1' || r.is_direct_ip === true);
  const visitedAts       = records.map(r =>
    r.ts ? new Date(parseInt(r.ts, 10)) : new Date()
  );

  await query(
    `INSERT INTO browser_history (user_id, device_id, lesson_session_id, url, title, action, block_reason, is_direct_ip, visited_at)
     SELECT * FROM unnest(
       $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::timestamptz[]
     )
     ON CONFLICT DO NOTHING`,
    [userIds, deviceIds, lessonSessionIds, urls, titles, actions, blockReasons, isDirectIps, visitedAts]
  );
}

async function insertOrForwardBrowserHistory(records) {
  await ensureInternalSecretSeeded();

  const { rows: [{ in_recovery }] } = await query('SELECT pg_is_in_recovery() AS in_recovery');
  if (!in_recovery) {
    return insertBrowserHistoryBatch(records);
  }

  const { rows: [primary] } = await query(
    `SELECT api_url FROM nodes WHERE ha_role = 'primary' AND is_active ORDER BY last_seen DESC LIMIT 1`
  );
  const { rows: [secretRow] } = await query(`SELECT value FROM settings WHERE key = 'internal_secret'`);
  if (!primary?.api_url || !secretRow?.value) {
    throw new Error('cannot forward browser history to primary — node/secret not found in replicated data yet');
  }

  await axios.post(`${primary.api_url}/api/v1/extension/internal/tab-events/bulk`, { records }, {
    headers: { 'x-internal-secret': secretRow.value },
    timeout: 8000,
  });
}

async function drainTabEvents() {
  let cursor = (await redis.get(TAB_CURSOR_KEY)) || '0';
  let total  = 0;

  while (true) {
    const result = await redis.xread('COUNT', TAB_DRAIN_BATCH, 'STREAMS', TAB_STREAM, cursor);
    if (!result || result.length === 0) break;

    const [, entries] = result[0];
    if (!entries || entries.length === 0) break;

    const records = entries.map(([id, fields]) => ({ id, ...parseStreamEntry(fields) }));

    await insertOrForwardBrowserHistory(records);

    cursor = entries[entries.length - 1][0];
    total += entries.length;

    await redis.xtrim(TAB_STREAM, 'MINID', cursor).catch(() => {});

    if (entries.length < TAB_DRAIN_BATCH) break;
  }

  if (total > 0) {
    await redis.set(TAB_CURSOR_KEY, cursor);
  }
}

// ---------------------------------------------------------------------------
// Penalty box expiry  — every 5 minutes
// Releases records whose expires_at has passed and invalidates policy cache.
// ---------------------------------------------------------------------------

async function expirePenaltyBox() {
  const { rows } = await query(`
    UPDATE penalty_box
    SET    released_at = NOW()
    WHERE  released_at IS NULL
      AND  expires_at  IS NOT NULL
      AND  expires_at  < NOW()
    RETURNING student_id
  `);

  if (rows.length === 0) return;

  const pipeline = redis.pipeline();
  for (const { student_id } of rows) {
    pipeline.del(`student:policy:${student_id}`);
  }
  await pipeline.exec();

  console.log(`[scheduler] released ${rows.length} expired penalty box record(s)`);
}

async function expireLockdownSessions() {
  const { rows } = await query(`
    UPDATE lockdown_sessions
    SET    status = 'expired', ended_at = NOW()
    WHERE  status  = 'active'
      AND  ends_at IS NOT NULL
      AND  ends_at < NOW()
    RETURNING student_id
  `);

  if (rows.length === 0) return;

  for (const { student_id } of rows) {
    await invalidatePolicy(student_id);
    events.emit('policy:updated', { studentId: student_id });
  }

  console.log(`[scheduler] expired ${rows.length} lockdown test session(s)`);
}

// ---------------------------------------------------------------------------
// Google Workspace sync stub  — nightly 2am
// Real implementation added in Phase 8.
// ---------------------------------------------------------------------------

async function syncGoogleWorkspace() {
  console.log('[scheduler] Google Workspace sync — not yet implemented (Phase 8)');
}

// ---------------------------------------------------------------------------
// Start all scheduled jobs
// ---------------------------------------------------------------------------

function startScheduler() {
  // DNS log drain runs on every node regardless of RUN_CRON_JOBS — a standby
  // actively serving DNS still has its own Redis stream of queries it
  // personally resolved, and those need draining (and, on a standby, forwarding
  // to the primary — see insertOrForwardDnsLogs) or they're silently lost.
  // Harmless no-op on a node that isn't serving DNS; the stream is just empty.
  cron.schedule('*/5 * * * * *', () => {
    drainDnsLog().catch(err => console.error('[scheduler] dns-log drain error:', err.message));
  });

  // Same reasoning as the DNS drain above — runs on every node regardless of
  // RUN_CRON_JOBS, since any node's API could have received extension
  // /tab-event calls into its own local Redis stream.
  cron.schedule('*/5 * * * * *', () => {
    drainTabEvents().catch(err => console.error('[scheduler] tab-events drain error:', err.message));
  });

  if (!config.node.runCronJobs) {
    console.log('[scheduler] other cron jobs disabled on this node (RUN_CRON_JOBS=false)');
    return;
  }

  console.log('[scheduler] starting background jobs');

  // Penalty box expiry — every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    expirePenaltyBox().catch(err => console.error('[scheduler] penalty-box expiry error:', err.message));
  });

  // Lockdown test session expiry — every minute, so a timed test actually
  // releases close to on time rather than lagging behind by minutes.
  cron.schedule('*/1 * * * *', () => {
    expireLockdownSessions().catch(err => console.error('[scheduler] lockdown expiry error:', err.message));
  });

  // Blocklist sync — configurable (default: 2am daily)
  cron.schedule(config.blocklist.syncCron, () => {
    console.log('[scheduler] starting scheduled blocklist sync');
    syncAll().catch(err => console.error('[scheduler] blocklist sync error:', err.message));
  });

  // Google Workspace sync — nightly 2am
  cron.schedule('0 2 * * *', () => {
    syncGoogleWorkspace().catch(err => console.error('[scheduler] google sync error:', err.message));
  });

  // Network controller → IPAM sync — every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    syncNetworkClientsToIpam().catch(err => console.error('[scheduler] ipam-sync error:', err.message));
  });

  // Mosyle/Google MDM device → IPAM sync — every 15 minutes; only links a
  // device when one of its known IPs matches a documented on-prem subnet
  // (offsite devices on home networks are correctly skipped, not errored).
  cron.schedule('*/15 * * * *', () => {
    integrationDeviceIpamSync.run().catch(err => console.error('[scheduler] integration-device-ipam-sync error:', err.message));
  });

  // Category list sync — weekly Sunday 3am (UT1 + Shallalist)
  cron.schedule('0 3 * * 0', () => {
    console.log('[scheduler] starting weekly category list sync');
    syncCategories().catch(err => console.error('[scheduler] category sync error:', err.message));
  });

  // Keyword classifier — daily 4am, processes uncategorized domains from DNS logs
  cron.schedule('0 4 * * *', () => {
    classifyRecentDomains(1000).catch(err => console.error('[scheduler] keyword classifier error:', err.message));
  });

  // Teacher period-utilization reconciliation — daily 4:30am, rolling 7-day
  // lookback so a late-closing screen_time_intervals row (device asleep,
  // reports back hours later) still lands in the right day's numbers.
  cron.schedule('30 4 * * *', () => {
    teacherUtilization.runNightly().catch(err => console.error('[scheduler] teacher-utilization error:', err.message));
  });

  // TLS certificate renewal check — daily 5am, renews within 30 days of expiry
  cron.schedule('0 5 * * *', () => {
    acmeTls.renewIfNeeded().catch(err => console.error('[scheduler] TLS renewal error:', err.message));
  });

  // Presence (ping) scan — every 10 minutes, subnets with scan_enabled=true
  cron.schedule('*/10 * * * *', () => {
    pingScan.scanAllSubnets().catch(err => console.error('[scheduler] ping-scan error:', err.message));
  });

  // DHCP lease → DNS auto-registration — every 5 minutes; no-op unless
  // explicitly enabled in Settings (dns.dhcp_auto_register)
  cron.schedule('*/5 * * * *', () => {
    dhcpDnsAutoRegister.run().catch(err => console.error('[scheduler] dhcp-dns-autoregister error:', err.message));
  });

  // Re-push subnets/reservations from Postgres into Kea — every 10 minutes.
  // Kea's command-API pushes are runtime-only and don't survive a container
  // restart, so this keeps Kea self-healing instead of relying on an admin
  // remembering to click "Sync to Kea".
  cron.schedule('*/10 * * * *', () => {
    dhcpKeaSync.run().catch(err => console.error('[scheduler] dhcp-kea-sync error:', err.message));
  });

  // DHCP active lease -> IPAM address status sync — every 2 minutes, so
  // IPAM reflects who currently holds a dynamically-leased IP.
  cron.schedule('*/2 * * * *', () => {
    dhcpLeaseIpamSync.run().catch(err => console.error('[scheduler] dhcp-lease-ipam-sync error:', err.message));
  });

  // Network controller client/AP sync — every 15 minutes. This was previously
  // ONLY triggered by an admin clicking "Sync"/"Sync All" in the UI - nothing
  // scheduled ever refreshed network_clients itself, so both this and the two
  // jobs below that read from it (RADIUS device promotion, IPAM) were quietly
  // working off however-stale that last manual click left things.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { rows } = await pool.query('SELECT id FROM network_controllers WHERE is_active = true');
      for (const { id } of rows) {
        await syncController(id).catch(err => console.error(`[scheduler] network-controller-sync ${id} error:`, err.message));
      }
    } catch (err) {
      console.error('[scheduler] network-controller-sync error:', err.message);
    }
  });

  // RADIUS device/NAS auto-provisioning — every 30 minutes. Pulls endpoint
  // MACs from Mosyle/Snipe-IT/Google Admin (auto-approved by default) and
  // AP/switch/gateway infrastructure from network controllers (auto-added
  // as NAS clients) so 802.1X access doesn't require manual entry per device.
  cron.schedule('*/30 * * * *', () => {
    radiusSync.syncAllSources().catch(err => console.error('[scheduler] radius-sync error:', err.message));
  });

  // NTP server polling — every 5 minutes. Previously only ran when an admin
  // clicked "Poll Now" on the NTP page, so the dashboard showed stale (or,
  // combined with a separate response-shape bug, no) data indefinitely.
  cron.schedule('*/5 * * * *', () => {
    ntp.pollAll().catch(err => console.error('[scheduler] ntp-poll error:', err.message));
  });
}

module.exports = {
  startScheduler, drainDnsLog, expirePenaltyBox, syncGoogleWorkspace, insertDnsLogBatch,
  drainTabEvents, insertBrowserHistoryBatch,
};
