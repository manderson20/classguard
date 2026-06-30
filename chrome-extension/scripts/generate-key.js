#!/usr/bin/env node
// One-time setup: generates the RSA keypair that permanently determines this
// extension's Chrome extension ID. Run manually, once, ever (per ClassGuard
// deployment) — re-running this is destructive: a new key means a new
// extension ID, which Chrome treats as an entirely different extension, and
// every already-enrolled device loses its update path to the old one.
//
//   docker compose run --rm extension-builder node scripts/generate-key.js
//
// The printed key must be copied into EVERY node's .env as
// EXTENSION_SIGNING_KEY — there is no shared filesystem between HA nodes,
// only Postgres replication, which doesn't cover .env. Same manual-sync
// requirement JWT_SECRET/DB_PASSWORD already have.
const crypto = require('crypto');
const ChromeExtension = require('crx');

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const encoded = Buffer.from(privateKey).toString('base64');

async function printExtensionId() {
  const crx = new ChromeExtension({ privateKey });
  // generateAppId() needs a loaded+packed extension to derive this.publicKey;
  // a single throwaway manifest is enough, only the key material matters.
  const tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cg-keygen-'));
  require('fs').writeFileSync(tmp + '/manifest.json', JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0.0' }));
  await crx.load(tmp);
  await crx.pack();
  return crx.generateAppId();
}

printExtensionId().then((extensionId) => {
  console.log('='.repeat(78));
  console.log('Generated a new extension signing key.');
  console.log('');
  console.log('Extension ID (will be permanent once this key is saved):');
  console.log('  ' + extensionId);
  console.log('');
  console.log('Add this EXACT line to .env on EVERY node in this cluster, then rerun');
  console.log('the extension build. Losing or regenerating this key changes the');
  console.log('extension ID and breaks auto-update for every already-enrolled device.');
  console.log('');
  console.log('EXTENSION_SIGNING_KEY=' + encoded);
  console.log('='.repeat(78));
}).catch((err) => {
  console.error('Key generation failed:', err.message);
  process.exit(1);
});
