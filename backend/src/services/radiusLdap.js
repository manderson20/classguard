/**
 * Google Secure LDAP authentication for FreeRADIUS EAP-TTLS/PAP.
 *
 * Google Secure LDAP setup (one-time, per school):
 *   Google Admin → Account → LDAP → Add LDAP Client
 *   Name: ClassGuard FreeRADIUS
 *   Permissions: Read user info + Verify user credentials (both needed --
 *     see the search-then-bind flow below)
 *   Download the certificate + private key (PKCS12 or separate PEM files)
 *   Store paths in ClassGuard settings:
 *     ldap_client_cert_path  = /etc/classguard/ldap-client.crt
 *     ldap_client_key_path   = /etc/classguard/ldap-client.key
 *     ldap_base_dn           = dc=school,dc=k12,dc=us  (your Workspace org's
 *                              base DN -- this is fixed per org, shared by
 *                              every domain/subdomain and every OU in it)
 *
 * Auth flow (called from /radius/authenticate) -- search-then-bind, not a
 * guessed DN:
 *   1. Connect to ldap.google.com:636 with TLS + client cert.
 *   2. Search the whole base DN (subtree scope) for (mail=<email>) to find
 *      the user's real DN, whatever OU or email domain they're actually
 *      under -- a district with e.g. @school.org staff and
 *      @students.school.org students in one Workspace org needs exactly one
 *      LDAP connection for this, not one per domain.
 *   3. Bind as that exact DN with the user's password to verify credentials.
 *   4. Return { ok: true } or { ok: false, reason: '...' }
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

function makeTlsClient(cert, key, timeout = 10_000) {
  return ldap.createClient({
    url:        'ldaps://ldap.google.com:636',
    // servername is required, not optional -- without it Node sends no SNI,
    // and Google's front end responds with its own diagnostic fallback cert
    // (CN=invalid2.invalid, "No SNI provided") instead of ldap.google.com's
    // real one, which then legitimately fails as a self-signed cert under
    // rejectUnauthorized. ldapjs doesn't derive this from `url` on its own.
    tlsOptions: { cert, key, rejectUnauthorized: true, servername: 'ldap.google.com' },
    timeout,
    connectTimeout: timeout,
  });
}

/**
 * Look up a user's real DN by their email address, rather than guessing one.
 * Google Secure LDAP's "Read user information" permission authorizes search
 * over the cert-authenticated connection itself -- no bind credentials
 * needed, same reason testConnection()'s anonymous bind succeeds at the TLS
 * layer even though Google rejects the empty bind DN/password. One search
 * across the whole base DN (which is fixed per Workspace org, not
 * per-domain) finds a user regardless of which email domain/subdomain they're
 * under or which OU they're actually in -- so this works for a district with
 * e.g. @school.org staff and @students.school.org students in the same
 * Workspace org without needing a separate LDAP connection per domain.
 */
async function searchUserDn(client, baseDn, email) {
  return new Promise((resolve, reject) => {
    client.search(baseDn, {
      scope:  'sub',
      filter: `(mail=${email.replace(/[()\\*\0]/g, '')})`,
      attributes: ['dn'],
    }, (err, res) => {
      if (err) return reject(err);
      let foundDn = null;
      res.on('searchEntry', (entry) => { foundDn = entry.objectName || entry.dn?.toString(); });
      res.on('error', (searchErr) => reject(searchErr));
      res.on('end', (result) => {
        if (result.status !== 0) return reject(new Error(`search failed, status ${result.status}`));
        resolve(foundDn);
      });
    });
  });
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

  // Step 1: find the user's real DN by searching on their email, instead of
  // guessing a fixed ou=Users path that breaks the moment a district's
  // Workspace org actually separates students/staff into different OUs.
  let userDn;
  const searchClient = makeTlsClient(cert, key);
  const searchClientError = new Promise((_, reject) => searchClient.on('error', reject));
  try {
    userDn = await Promise.race([searchUserDn(searchClient, baseDn, email), searchClientError]);
  } catch (e) {
    searchClient.unbind();
    return { ok: false, reason: `LDAP search error: ${e.message}` };
  }
  searchClient.unbind();

  if (!userDn) {
    return { ok: false, reason: 'user not found in directory' };
  }

  // Step 2: verify credentials with a fresh bind as that exact DN -- LDAP
  // binds are connection-scoped, so reusing the search connection for this
  // (rather than a new one) risks state left over from the first operation.
  return new Promise((resolve) => {
    const bindClient = makeTlsClient(cert, key);

    bindClient.on('error', (err) => {
      resolve({ ok: false, reason: `LDAP connection error: ${err.message}` });
    });

    bindClient.bind(userDn, password, (err) => {
      bindClient.unbind();
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
    const client = makeTlsClient(cert, key, 8_000);
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
