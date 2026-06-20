require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  // A standby's schema is whatever the primary has, via streaming
  // replication — there's nothing for it to migrate itself, and any DDL
  // attempt (even a no-op CREATE TABLE IF NOT EXISTS) fails outright
  // against a read-only replica before it even checks if the table exists.
  const { rows: [{ in_recovery }] } = await pool.query('SELECT pg_is_in_recovery() AS in_recovery');
  if (in_recovery) {
    console.log('This node is a read-only standby — skipping migrations (schema comes from the primary via replication).');
    await pool.end();
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  const dir   = path.join(__dirname, '../db/migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT filename FROM schema_migrations WHERE filename = $1',
      [file]
    );

    if (rows.length > 0) {
      console.log(`  skip  ${file}`);
      continue;
    }

    console.log(`  apply ${file}`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    console.log(`  done  ${file}`);
  }

  await pool.end();
  console.log('Migrations complete.');
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
