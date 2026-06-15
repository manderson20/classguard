const cron   = require('node-cron');
const redis  = require('../redis');
const { query } = require('../db');
const config = require('../config');
const { syncAll } = require('./blocklistSync');

// ---------------------------------------------------------------------------
// DNS log drain  — every 30 seconds
// Reads entries from the Redis stream 'classguard:dns-log' written by the
// DNS engine and bulk-inserts them into the dns_logs PostgreSQL table.
// ---------------------------------------------------------------------------

const DNS_STREAM   = 'classguard:dns-log';
const CURSOR_KEY   = 'classguard:dns-log:cursor';
const DRAIN_BATCH  = 500;

function parseStreamEntry(fields) {
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

async function drainDnsLog() {
  const cursor = (await redis.get(CURSOR_KEY)) || '0';

  const result = await redis.xread('COUNT', DRAIN_BATCH, 'STREAMS', DNS_STREAM, cursor);
  if (!result || result.length === 0) return;

  const [, entries] = result[0];
  if (!entries || entries.length === 0) return;

  const records = entries.map(([id, fields]) => ({ id, ...parseStreamEntry(fields) }));

  // Batch INSERT — 5 columns × up to 500 rows = up to 2500 params (well under pg limit)
  const valueParts = records.map((_, i) => {
    const b = i * 5;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
  });

  const params = records.flatMap(r => [
    r.studentId   || null,
    r.domain      || '',
    r.action      || 'allowed',
    r.blockReason || null,
    r.timestamp   ? new Date(parseInt(r.timestamp, 10)) : new Date(),
  ]);

  await query(
    `INSERT INTO dns_logs (user_id, domain, action, block_reason, queried_at)
     VALUES ${valueParts.join(', ')}
     ON CONFLICT DO NOTHING`,
    params
  );

  const lastId = entries[entries.length - 1][0];
  await redis.set(CURSOR_KEY, lastId);
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

  // DNS log drain — every 30 seconds
  cron.schedule('*/30 * * * * *', () => {
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
}

module.exports = { startScheduler, drainDnsLog, expirePenaltyBox, syncGoogleWorkspace };
