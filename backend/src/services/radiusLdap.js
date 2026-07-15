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
function escapeLdapFilter(val) {
  return String(val).replace(/[\\()*\x00]/g, c => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

async function searchUserDn(client, baseDn, email) {
  return new Promise((resolve, reject) => {
    client.search(baseDn, {
      scope:  'sub',
      filter: `(mail=${escapeLdapFilter(email)})`,
      attributes: ['dn'],
    }, (err, res) => {
      if (err) return reject(err);
      let foundDn = null;
      res.on('searchEntry', (entry) => {
        // entry.objectName is a @ldapjs/dn DN *instance*, not a plain
        // string -- ldapjs's own setter converts whatever string you give
        // it into one internally, and the getter hands that object straight
        // back. Passing it on to bind() un-stringified is exactly what
        // produced "stringToWrite must be a string": something downstream
        // expects a real string and gets an object with a toString() method
        // instead. Force it to a string here, once, rather than relying on
        // truthy-object short-circuiting to "do the right thing".
        const raw = entry.objectName ?? entry.dn;
        foundDn = raw != null ? String(raw) : null;
      });
      res.on('error', (searchErr) => reject(searchErr));
      res.on('end', (result) => {
        if (result.status !== 0) return reject(new Error(`search failed, status ${result.status}`));
        resolve(foundDn);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Persistent connection layer.
//
// A TLS handshake to ldap.google.com costs ~500-900ms; a fresh search+bind
// connection pair per auth (~1.5-2s total) LOSES THE RACE against UniFi APs'
// 2-second RADIUS retransmit timer: the duplicate request collides with the
// original inside FreeRADIUS, whose EAP session is already consumed, and a
// successful Google bind still comes back to the phone as Access-Reject.
// (Observed live: bind verified at t+1.7s, AP retransmit at t+2.0s → reject.)
//
// So, like rlm_ldap on a classic FreeRADIUS+Google setup: one persistent
// cert-authenticated connection for DN searches, an email→DN cache, and a
// small pool of open connections re-bound per user (a bind supersedes the
// previous bind on that connection). Steady-state auth = one bind round-trip.
// ---------------------------------------------------------------------------

let searchConn = null;
const bindPool = [];
const BIND_POOL_MAX = 4;
const dnCache = new Map(); // email -> { dn, at }
const DN_CACHE_TTL_MS = 30 * 60_000;
const DN_CACHE_MAX = 5000;
let keepaliveTimer = null;
let lastCreds = null; // { cert, key, baseDn } from the most recent auth

function destroyClient(c) {
  if (!c) return;
  c._cgAlive = false;
  try { c.destroy(); } catch { /* already closed */ }
}

function newTrackedClient(cert, key) {
  const c = makeTlsClient(cert, key);
  c._cgAlive = true;
  const dead = () => { c._cgAlive = false; };
  c.on('error', dead);
  c.on('close', dead);
  return c;
}

function getBindConn(cert, key) {
  while (bindPool.length) {
    const c = bindPool.pop();
    if (c._cgAlive) return c;
    destroyClient(c);
  }
  return newTrackedClient(cert, key);
}

function releaseBindConn(c) {
  if (c._cgAlive && bindPool.length < BIND_POOL_MAX) bindPool.push(c);
  else destroyClient(c);
}

function cacheDn(email, dn) {
  if (dnCache.size >= DN_CACHE_MAX) dnCache.clear(); // crude but bounded
  dnCache.set(email, { dn, at: Date.now() });
}

function cachedDn(email) {
  const hit = dnCache.get(email);
  if (hit && Date.now() - hit.at < DN_CACHE_TTL_MS) return hit.dn;
  dnCache.delete(email);
  return null;
}

// Google closes idle LDAP connections; a cheap periodic operation keeps the
// warm connections warm so the *first* auth after a quiet spell doesn't pay
// the handshake tax (and lose the retransmit race) either.
function ensureKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    if (!lastCreds) return;
    const { cert, key, baseDn } = lastCreds;
    if (searchConn?._cgAlive) {
      searchUserDn(searchConn, baseDn, 'keepalive@invalid.invalid').catch(() => {
        destroyClient(searchConn); searchConn = null;
      });
    }
    for (const c of bindPool.filter(c => c._cgAlive)) {
      // Anonymous bind: Google answers 49 (invalidCredentials) but the
      // round-trip keeps the connection alive.
      c.bind('', '', () => {});
    }
    // Keep at least one warm connection of each kind ready
    if (!searchConn || !searchConn._cgAlive) searchConn = newTrackedClient(cert, key);
    if (!bindPool.some(c => c._cgAlive)) bindPool.push(newTrackedClient(cert, key));
  }, 3 * 60_000);
  keepaliveTimer.unref?.();
}

function bindAsUser(conn, userDn, password) {
  return new Promise((resolve) => {
    let settled = false;
    // Named + removed afterwards: pooled connections are reused across many
    // binds, and a plain .on() per bind would stack listeners forever.
    const onError = (err) => done({ ok: false, reason: `LDAP connection error: ${err.message}`, connError: true });
    const done = (v) => {
      if (settled) return;
      settled = true;
      conn.removeListener('error', onError);
      resolve(v);
    };
    conn.on('error', onError);
    conn.bind(userDn, password, (err) => {
      if (err) {
        done(err.code === 49
          ? { ok: false, reason: 'invalid credentials' }
          : { ok: false, reason: err.message, connError: true });
      } else {
        done({ ok: true });
      }
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

  lastCreds = { cert, key, baseDn };
  ensureKeepalive();

  // Normalise username to email
  const email = username.includes('@') ? username.toLowerCase() : null;
  if (!email) return { ok: false, reason: 'username must be an email address' };

  // Step 1: the user's real DN — from cache, else search on the persistent
  // connection (retry once on a stale/dead connection).
  let userDn = cachedDn(email);
  if (!userDn) {
    for (let attempt = 0; attempt < 2 && !userDn; attempt++) {
      if (!searchConn?._cgAlive) searchConn = newTrackedClient(cert, key);
      const conn = searchConn;
      let onError;
      const connError = new Promise((_, rej) => { onError = rej; conn.once('error', onError); });
      try {
        userDn = await Promise.race([searchUserDn(conn, baseDn, email), connError]);
        conn.removeListener('error', onError);
        break;
      } catch (e) {
        conn.removeListener('error', onError);
        destroyClient(conn);
        if (searchConn === conn) searchConn = null;
        if (attempt === 1) return { ok: false, reason: `LDAP search error: ${e.message}` };
      }
    }
    if (!userDn) return { ok: false, reason: 'user not found in directory' };
    cacheDn(email, userDn);
  }

  // Step 2: verify credentials by binding as that DN on a pooled connection.
  // Retry once on connection-level errors (a pooled socket can go stale).
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = getBindConn(cert, key);
    const result = await bindAsUser(conn, userDn, password);
    if (result.connError) { destroyClient(conn); continue; }
    releaseBindConn(conn);
    // A failed bind against an *older* cached DN could mean the DN went
    // stale (user renamed/moved) — drop it so the next attempt re-searches.
    // A fresh entry (< 60s) was just verified by search; keep it so a
    // password typo + retry only pays one Google round-trip, not two.
    if (!result.ok) {
      const hit = dnCache.get(email);
      if (hit && Date.now() - hit.at > 60_000) dnCache.delete(email);
    }
    return { ok: result.ok, reason: result.reason };
  }
  return { ok: false, reason: 'LDAP connection error (bind)' };
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
