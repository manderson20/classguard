#!/usr/bin/env node
// Builds the extension, then produces everything Chrome's self-hosted
// update mechanism needs: a signed .crx, an Omaha-protocol update.xml, and
// the resulting extension ID (for the admin to paste into Google Admin
// Console). Also keeps the plain .zip for manual/dev-mode sideloading.
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const ChromeExtension = require('crx');

const OUT_DIR  = '/output';
const DIST_DIR = path.join(__dirname, '..', 'dist');
const BACKEND_URL = process.env.BACKEND_URL || 'https://classguard.example.org';

function fail(msg) {
  console.error('\n' + '='.repeat(78));
  console.error(msg);
  console.error('='.repeat(78) + '\n');
  process.exit(1);
}

async function main() {
  const keyB64 = process.env.EXTENSION_SIGNING_KEY;
  if (!keyB64) {
    fail(
      'EXTENSION_SIGNING_KEY is not set — refusing to build.\n\n' +
      'This key permanently determines the extension\'s Chrome extension ID,\n' +
      'so it is generated once, deliberately, not invented on every build.\n' +
      'Run this once, then add the printed EXTENSION_SIGNING_KEY line to .env\n' +
      'on every node in this cluster:\n\n' +
      '  docker compose run --rm extension-builder node scripts/generate-key.js'
    );
  }
  const privateKey = Buffer.from(keyB64, 'base64');

  console.log('[build] webpack --mode production');
  execSync('npm run build', { stdio: 'inherit', cwd: path.join(__dirname, '..') });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('[build] zipping dist/ -> classguard-extension.zip');
  fs.rmSync(path.join(OUT_DIR, 'classguard-extension.zip'), { force: true });
  execSync(`zip -rq ${path.join(OUT_DIR, 'classguard-extension.zip')} .`, { cwd: DIST_DIR, stdio: 'inherit' });

  console.log('[build] signing dist/ -> classguard-extension.crx');
  const codebase = `${BACKEND_URL}/downloads/classguard-extension.crx`;
  const crx = new ChromeExtension({ privateKey, codebase });
  await crx.load(DIST_DIR);
  const crxBuffer = await crx.pack();
  fs.writeFileSync(path.join(OUT_DIR, 'classguard-extension.crx'), crxBuffer);

  const extensionId = crx.generateAppId();
  fs.writeFileSync(path.join(OUT_DIR, 'extension-id.txt'), extensionId + '\n');

  console.log('[build] writing update.xml');
  fs.writeFileSync(path.join(OUT_DIR, 'update.xml'), crx.generateUpdateXML());

  console.log('[build] done. extension ID: ' + extensionId);
}

main().catch((err) => fail('Build failed: ' + err.message));
