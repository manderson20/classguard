const cron   = require('node-cron');
const redis  = require('../redis');
const { query } = require('../db');
const config = require('../config');
const { syncAll } = require('./blocklistSync');
const { syncNetworkClientsToIpam } = require('./ipamSync');

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

    // Use unnest() arrays — single round-trip regardless of row count,
    // and avoids the 65535-parameter limit of $1..$N style inserts.
    const userIds      = records.map(r => r.studentId   || null);
    const domains      = records.map(r => r.domain      || '');
    const actions      = records.map(r => r.action      || 'allowed');
    const blockReasons = records.map(r => r.blockReason || null);
    const queriedAts   = records.map(r =>
      r.timestamp ? new Date(parseInt(r.timestamp, 10)) : new Date()
    );

    await query(
      `INSERT INTO dns_logs (user_id, domain, action, block_reason, queried_at)
       SELECT * FROM unnest(
         $1::uuid[], $2::text[], $3::text[], $4::text[], $5::timestamptz[]
       )
       ON CONFLICT DO NOTHING`,
      [userIds, domains, actions, blockReasons, queriedAts]
    );

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

// ---------------------------------------------------------------------------
// Node heartbeat  — every 30 seconds
// Upserts this node's record in the nodes table for HA visibility.
// ---------------------------------------------------------------------------

async function heartbeat() {
  const hostname = require('os').hostname();
  await query(`
    INSERT INTO nodes (hostname, ip, role, last_heartbeat, is_active)
    VALUES ($1, $2, $3, NOW(), true)
    ON CONFLICT (hostname) DO UPDATE SET
      last_heartbeat = NOW(),
      is_active      = true,
      role           = EXCLUDED.role
  `, [hostname, process.env.NODE_IP || '0.0.0.0', config.node.role]).catch(() => {});
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
  if (!config.node.runCronJobs) {
    console.log('[scheduler] cron jobs disabled on this node (RUN_CRON_JOBS=false)');
    return;
  }

  console.log('[scheduler] starting background jobs');

  // DNS log drain — every 5 seconds (handles 269M+/month without backlog)
  cron.schedule('*/5 * * * * *', () => {
    drainDnsLog().catch(err => console.error('[scheduler] dns-log drain error:', err.message));
  });

  // Penalty box expiry — every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    expirePenaltyBox().catch(err => console.error('[scheduler] penalty-box expiry error:', err.message));
  });

  // Node heartbeat — every 30 seconds
  cron.schedule('*/30 * * * * *', () => {
    heartbeat().catch(() => {}); // silent — non-critical
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
  // Syncs live network clients (MAC, IP, hostname) into IPAM ip_addresses records.
  cron.schedule('*/15 * * * *', () => {
    syncNetworkClientsToIpam().catch(err => console.error('[scheduler] ipam-sync error:', err.message));
  });
}

module.exports = { startScheduler, drainDnsLog, expirePenaltyBox, syncGoogleWorkspace };
