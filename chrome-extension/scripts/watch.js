#!/usr/bin/env node
// Long-running poller — the default command for the extension-builder
// service. Polls the backend every POLL_INTERVAL_MS for the Chrome
// extension's OAuth client ID + public URL (Settings > Integrations >
// Chrome Extension, stored in Postgres) and rebuilds whenever they change.
// Replaces the old workflow of manually re-running `docker compose run
// --rm extension-builder` after editing .env on every node.
const http  = require('http');
const https = require('https');
const { runBuild } = require('./lib/runBuild');

const POLL_INTERVAL_MS = 60_000;
const API_BASE = process.env.INTERNAL_API_URL || 'http://api:3001';

function fetchConfig() {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/extension/build-config', API_BASE);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`build-config fetch failed: ${res.statusCode} ${body}`));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
  });
}

let lastApplied = null;

async function tick() {
  let cfg;
  try {
    cfg = await fetchConfig();
  } catch (err) {
    console.error('[watch] could not reach backend for build config:', err.message);
    return;
  }

  if (!cfg.googleClientId) {
    console.warn('[watch] extension_oauth_client_id is not set — skipping build. ' +
      'Configure it under Integrations > Chrome Extension in the admin UI.');
    return;
  }
  if (!cfg.publicUrl) {
    console.warn('[watch] no public URL resolved (extension_public_url / TLS domain / APP_URL all empty) — skipping build.');
    return;
  }

  const fingerprint = `${cfg.googleClientId}|${cfg.publicUrl}`;
  if (fingerprint === lastApplied) return;

  console.log(`[watch] config changed (publicUrl source: ${cfg.urlSource}) — rebuilding...`);
  try {
    const { extensionId } = await runBuild({ backendUrl: cfg.publicUrl, googleClientId: cfg.googleClientId });
    lastApplied = fingerprint;
    console.log(`[watch] build complete. extension ID: ${extensionId}, publicUrl: ${cfg.publicUrl}`);
  } catch (err) {
    console.error('[watch] build failed, will retry next poll:', err.message);
  }
}

async function main() {
  console.log(`[watch] polling ${API_BASE} every ${POLL_INTERVAL_MS / 1000}s for extension build config`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main();
