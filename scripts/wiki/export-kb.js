// Dump the knowledge-base articles as JSON for the wiki generator.
// Run inside the API container (it has `pg` and DATABASE_URL):
//
//   docker exec classguard-api node /app/src/../../scripts/wiki/export-kb.js  # if mounted
//   # or, the portable form used in the README:
//   docker exec classguard-api node -e "$(cat scripts/wiki/export-kb.js)" > scripts/wiki/kb-export.json
//
// Emits an array of { slug, title, category, content, page_paths,
// updated_at, content_version } to stdout.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(
  `SELECT slug, title, category, content, page_paths, updated_at, content_version
   FROM kb_articles ORDER BY category, title`
).then(r => {
  process.stdout.write(JSON.stringify(r.rows, null, 2));
  return pool.end();
}).catch(e => { console.error(e.message); process.exit(1); });
