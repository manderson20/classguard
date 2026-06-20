/**
 * Google Secure LDAP authentication for FreeRADIUS EAP-TTLS/PAP.
 *
 * Google Secure LDAP setup (one-time, per school):
 *   Google Admin → Account → LDAP → Add LDAP Client
 *   Name: ClassGuard FreeRADIUS
 *   Permissions: Read user info + credentials verification
 *   Download the certificate + private key (PKCS12 or separate PEM files)
 *   Store paths in ClassGuard settings:
 *     ldap_client_cert_path  = /etc/classguard/ldap-client.crt
 *     ldap_client_key_path   = /etc/classguard/ldap-client.key
 *     ldap_base_dn           = dc=school,dc=k12,dc=us  (your domain in DC notation)
 *
 * Auth flow (called from /radius/authenticate):
 *   1. Connect to ldap.google.com:636 with TLS + client cert
 *   2. Attempt simple bind as uid=user@domain,ou=Users,dc=domain,...
 *   3. Return { ok: true } or { ok: false, reason: '...' }
 */

const fs   = require('fs');
const ldap = require('ldapjs');
const { pool } = require('../db');

// Cache settings for 60s so we don't query DB on every auth
let settingsCache   = null;
let settingsCacheAt = 0;

async function getLdapSettings() {
  if (settingsCache && Date.now() - settingsCacheAt < 60_000) return settingsCache;

  const { rows } = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('ldap_client_cert_path','ldap_client_key_path','ldap_base_dn',
                   'ldap_google_domain','ldap_google_enabled')`
  );
  settingsCache   = Object.fromEntries(rows.map(r => [r.key, r.value]));
  settingsCacheAt = Date.now();
  return settingsCache;
}

/**
 * Validate a user's credentials against Google Secure LDAP.
 * @param {string} username  - email address (user@school.edu)
 * @param {string} password  - cleartext (received inside EAP-TTLS tunnel)
 * @returns {{ ok: boolean, reason?: string }}
 */
async function authenticateUser(username, password) {
  if (!username || !password) return { ok: false, reason: 'missing credentials' };

  const cfg = await getLdapSettings();

  if (cfg.ldap_google_enabled === 'false') {
    return { ok: false, reason: 'Google Secure LDAP is disabled in settings' };
  }

  const certPath = cfg.ldap_client_cert_path || process.env.LDAP_CLIENT_CERT_PATH;
  const keyPath  = cfg.ldap_client_key_path  || process.env.LDAP_CLIENT_KEY_PATH;
  const baseDn   = cfg.ldap_base_dn          || process.env.LDAP_BASE_DN;

  if (!certPath || !keyPath || !baseDn) {
    return { ok: false, reason: 'Google Secure LDAP not configured (missing cert/key/base_dn)' };
  }

  let cert, key;
  try {
    cert = fs.readFileSync(certPath);
    key  = fs.readFileSync(keyPath);
  } catch (e) {
    return { ok: false, reason: `Cannot read LDAP cert/key: ${e.message}` };
  }

  // Normalise username to email
  const email = username.includes('@') ? username.toLowerCase() : null;
  if (!email) return { ok: false, reason: 'username must be an email address' };

  // Build the user DN for a simple bind
  // Google Secure LDAP user DN: uid=user@domain.com,ou=Users,dc=domain,dc=com
  const userDn = `uid=${email},ou=Users,${baseDn}`;

  return new Promise((resolve) => {
    const client = ldap.createClient({
      url:        'ldaps://ldap.google.com:636',
      tlsOptions: {
        cert,
        key,
        rejectUnauthorized: true,
      },
      timeout:        10_000,
      connectTimeout: 10_000,
    });

    client.on('error', (err) => {
      resolve({ ok: false, reason: `LDAP connection error: ${err.message}` });
    });

    client.bind(userDn, password, (err) => {
      client.unbind();
      if (err) {
        const reason = err.code === 49 ? 'invalid credentials' : err.message;
        resolve({ ok: false, reason });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Test the LDAP connection (without authenticating a user).
 * Does an anonymous bind to verify the client cert works.
 */
async function testConnection() {
  const cfg = await getLdapSettings();

  const certPath = cfg.ldap_client_cert_path || process.env.LDAP_CLIENT_CERT_PATH;
  const keyPath  = cfg.ldap_client_key_path  || process.env.LDAP_CLIENT_KEY_PATH;

  if (!certPath || !keyPath) {
    return { ok: false, reason: 'cert/key paths not configured' };
  }

  let cert, key;
  try {
    cert = fs.readFileSync(certPath);
    key  = fs.readFileSync(keyPath);
  } catch (e) {
    return { ok: false, reason: `Cannot read cert/key: ${e.message}` };
  }

  return new Promise((resolve) => {
    const client = ldap.createClient({
      url:        'ldaps://ldap.google.com:636',
      tlsOptions: { cert, key, rejectUnauthorized: true },
      timeout:        8_000,
      connectTimeout: 8_000,
    });
    client.on('error', err => resolve({ ok: false, reason: err.message }));
    // Anonymous bind to google LDAP just tests TLS + cert
    client.bind('', '', (err) => {
      client.unbind();
      // Google returns invalidCredentials for anon bind but the TLS handshake succeeded
      if (!err || err.code === 49) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: err.message });
      }
    });
  });
}

function invalidateSettingsCache() {
  settingsCache   = null;
  settingsCacheAt = 0;
}

module.exports = { authenticateUser, testConnection, invalidateSettingsCache };
