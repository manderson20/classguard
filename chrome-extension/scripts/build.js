#!/usr/bin/env node
// Manual one-shot build. Normal operation no longer needs this — the
// extension-builder service runs scripts/watch.js continuously and rebuilds
// automatically when Settings > Integrations > Chrome Extension config
// changes in the database. Kept for manual/CI use (e.g. testing a code
// change locally before bumping the version):
//   docker compose run --rm -e BACKEND_URL=... -e GOOGLE_CLIENT_ID=... extension-builder node scripts/build.js
const { runBuild } = require('./lib/runBuild');

const BACKEND_URL   = process.env.BACKEND_URL || 'https://classguard.example.org';
const GOOGLE_CLIENT = process.env.GOOGLE_CLIENT_ID || '';

runBuild({ backendUrl: BACKEND_URL, googleClientId: GOOGLE_CLIENT })
  .then(({ extensionId }) => console.log('[build] done. extension ID: ' + extensionId))
  .catch((err) => {
    console.error('\n' + '='.repeat(78) + '\n' + err.message + '\n' + '='.repeat(78) + '\n');
    process.exit(1);
  });
