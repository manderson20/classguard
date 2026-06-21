// Core build pipeline: webpack -> zip -> sign .crx -> write update.xml.
// Shared by scripts/build.js (manual one-shot CLI) and scripts/watch.js
// (the long-running poller that rebuilds automatically when Settings >
// Integrations > Chrome Extension config changes).
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const ChromeExtension = require('crx');

const OUT_DIR     = '/output';
const PACKAGE_DIR = path.join(__dirname, '..', '..');
const DIST_DIR    = path.join(PACKAGE_DIR, 'dist');

async function runBuild({ backendUrl, googleClientId }) {
  const keyB64 = process.env.EXTENSION_SIGNING_KEY;
  if (!keyB64) {
    throw new Error(
      'EXTENSION_SIGNING_KEY is not set — refusing to build.\n\n' +
      'This key permanently determines the extension\'s Chrome extension ID,\n' +
      'so it is generated once, deliberately, not invented on every build.\n' +
      'Run this once, then add the printed EXTENSION_SIGNING_KEY line to .env\n' +
      'on every node in this cluster:\n\n' +
      '  docker compose run --rm extension-builder node scripts/generate-key.js'
    );
  }
  const privateKey = Buffer.from(keyB64, 'base64');

  // webpack.config.js reads these via dotenv-loaded process.env; set them
  // here so execSync's child inherits the values this call was given,
  // regardless of what's in .env.
  const buildEnv = { ...process.env, BACKEND_URL: backendUrl, GOOGLE_CLIENT_ID: googleClientId };

  execSync('npm run build', { stdio: 'inherit', cwd: PACKAGE_DIR, env: buildEnv });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(path.join(OUT_DIR, 'classguard-extension.zip'), { force: true });
  execSync(`zip -rq ${path.join(OUT_DIR, 'classguard-extension.zip')} .`, { cwd: DIST_DIR, stdio: 'inherit' });

  const codebase = `${backendUrl}/downloads/classguard-extension.crx`;
  const crx = new ChromeExtension({ privateKey, codebase });
  await crx.load(DIST_DIR);
  const crxBuffer = await crx.pack();
  fs.writeFileSync(path.join(OUT_DIR, 'classguard-extension.crx'), crxBuffer);

  const extensionId = crx.generateAppId();
  fs.writeFileSync(path.join(OUT_DIR, 'extension-id.txt'), extensionId + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'update.xml'), crx.generateUpdateXML());

  return { extensionId };
}

module.exports = { runBuild };
