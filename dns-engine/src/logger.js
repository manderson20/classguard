const redis = require('./redis');

const STREAM_KEY  = 'classguard:dns-log';
const MAX_LEN     = 50000; // cap stream length; backend drains it every 30s

/**
 * Append a query result to the Redis stream.
 * The backend scheduler drains this stream and writes to the dns_logs table.
 */
async function logQuery({ domain, action, sourceIp, studentId, policyId, blockReason }) {
  try {
    await redis.xadd(
      STREAM_KEY,
      'MAXLEN', '~', MAX_LEN,  // approximate trimming for performance
      '*',                       // auto-generate stream ID
      'domain',      domain      || '',
      'action',      action      || 'allowed',
      'sourceIp',    sourceIp    || '',
      'studentId',   studentId   || '',
      'policyId',    policyId    || '',
      'blockReason', blockReason || '',
      'timestamp',   Date.now().toString(),
    );
  } catch {
    // Never let logging errors break DNS resolution
  }
}

module.exports = { logQuery };
