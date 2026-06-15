const redis = require('./redis');

const STREAM_KEY = 'classguard:dns-log';

// In-process ring buffer — absorbs bursts before the Redis write.
// This decouples DNS resolution latency from logging I/O entirely.
// At 500 q/s peak for 30s between flushes = 15,000 entries; 100k is well above that.
const RING_SIZE = 100_000;
const ring      = new Array(RING_SIZE);
let   ringHead  = 0;
let   ringTail  = 0;
let   ringCount = 0;

function enqueue(entry) {
  if (ringCount >= RING_SIZE) {
    // Ring full — drop oldest (tail advances). Under extreme load, we prefer
    // dropping old log entries over blocking the DNS resolver.
    ringTail = (ringTail + 1) % RING_SIZE;
    ringCount--;
  }
  ring[ringHead] = entry;
  ringHead = (ringHead + 1) % RING_SIZE;
  ringCount++;
}

function dequeueAll() {
  if (ringCount === 0) return [];
  const items = [];
  while (ringCount > 0) {
    items.push(ring[ringTail]);
    ring[ringTail] = null; // release ref for GC
    ringTail = (ringTail + 1) % RING_SIZE;
    ringCount--;
  }
  return items;
}

// Background drain to Redis every 200ms — pipelines up to 5k entries per batch.
let drainRunning  = false;
const DRAIN_BATCH = 5_000;
// Stream max length: ~2M entries. At 100 q/s average that's ~5.5 hours of
// headroom; the backend drains to Postgres every 5s so the stream stays small.
const STREAM_MAX  = '2000000';

async function flushToRedis() {
  if (drainRunning) return;
  drainRunning = true;
  try {
    const items = dequeueAll();
    if (items.length === 0) return;

    for (let i = 0; i < items.length; i += DRAIN_BATCH) {
      const chunk    = items.slice(i, i + DRAIN_BATCH);
      const pipeline = redis.pipeline();
      for (const e of chunk) {
        pipeline.xadd(
          STREAM_KEY,
          'MAXLEN', '~', STREAM_MAX,
          '*',
          'domain',      e.domain,
          'action',      e.action,
          'sourceIp',    e.sourceIp,
          'studentId',   e.studentId,
          'policyId',    e.policyId,
          'blockReason', e.blockReason,
          'timestamp',   e.timestamp,
        );
      }
      await pipeline.exec();
    }
  } catch {
    // Redis unavailable — entries remain droppable; DNS resolution unaffected
  } finally {
    drainRunning = false;
  }
}

setInterval(() => {
  flushToRedis().catch(() => {});
}, 200);

/**
 * logQuery — synchronous ring buffer enqueue. Zero I/O on the hot DNS path.
 * Called without `await` from resolver.js so resolution never waits for logging.
 */
function logQuery({ domain, action, sourceIp, studentId, policyId, blockReason }) {
  enqueue({
    domain:      domain      || '',
    action:      action      || 'allowed',
    sourceIp:    sourceIp    || '',
    studentId:   studentId   || '',
    policyId:    policyId    || '',
    blockReason: blockReason || '',
    timestamp:   Date.now().toString(),
  });
}

module.exports = { logQuery };
