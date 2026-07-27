const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.db.url,
  max: 20,
  // A quiet standby otherwise cycles its last connection every 30s, and each
  // reconnect goes through a getaddrinfo that competes for libuv's slow-I/O
  // threadpool slots — the feedback loop behind the 2026-07 classguard2
  // "database unreachable" episodes. Keep connections warm instead.
  idleTimeoutMillis: 10 * 60 * 1000,
  keepAlive: true,
  // 2s was aggressive enough that a transient slow DNS lookup failed the
  // connect, and every failed connect enqueued yet another lookup.
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

const query = (text, params) => pool.query(text, params);

const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// --- DB-unreachable watchdog -------------------------------------------------
// A wedged process (e.g. a runaway getaddrinfo queue starving new socket
// setup) can sit for hours unable to open a single DB connection while the
// database itself is healthy. No amount of in-process retrying recovers from
// that, but a clean restart does — so after WATCHDOG_MAX consecutive probe
// failures the process exits and Docker's restart policy brings it back
// fresh. The probe doubles as a keep-warm touch so the pool always holds at
// least one live connection. The interval is unref()'d so one-off scripts
// that require this module still exit normally (and never trigger the
// watchdog). Set DB_WATCHDOG=off to disable.
const WATCHDOG_INTERVAL_MS = 30 * 1000;
const WATCHDOG_MAX = 10; // ~5 minutes of continuous failure

let watchdogFailures = 0;
if (process.env.DB_WATCHDOG !== 'off') {
  const timer = setInterval(async () => {
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('watchdog probe timed out')), 15000)),
      ]);
      watchdogFailures = 0;
    } catch (err) {
      watchdogFailures += 1;
      console.error(`DB watchdog: probe failed (${watchdogFailures}/${WATCHDOG_MAX}): ${err.message}`);
      if (watchdogFailures >= WATCHDOG_MAX) {
        console.error('DB watchdog: database unreachable for ~5 minutes with a healthy container network — exiting so Docker restarts the process clean.');
        process.exit(1);
      }
    }
  }, WATCHDOG_INTERVAL_MS);
  timer.unref();
}

module.exports = { pool, query, withTransaction };
