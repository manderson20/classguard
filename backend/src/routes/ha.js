const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermission } = require('../middleware/permissions');
const config     = require('../config');
const keepalived = require('../services/keepalived');
const events     = require('../events');
const mailer     = require('../services/mailer');

const auth      = [authenticate, requirePermission('ha_monitoring')];
const superauth = [authenticate, requireMinRole('superadmin')];

// ---------------------------------------------------------------------------
// ECDH helpers — encrypt/decrypt the sensitive join-response payload so
// JWT_SECRET, EXTENSION_SIGNING_KEY, and replication credentials never
// travel plaintext over the wire, even on a private LAN.
//
// Protocol (one round-trip):
//   1. Joining node generates an ephemeral P-256 keypair, sends its public key
//      with the /join request.
//   2. Primary generates its own ephemeral P-256 keypair, computes the ECDH
//      shared secret, derives a 256-bit AES-GCM key via HKDF-SHA-256, and
//      encrypts the secret payload.  Returns its public key + ciphertext.
//   3. Joining node computes the same shared secret from its private key +
//      the primary's public key, derives the same AES-GCM key, decrypts.
//
// A passive sniffer sees both public keys and the ciphertext — none of that
// is sufficient to decrypt without one of the ephemeral private keys, which
// never leave their respective processes.
// ---------------------------------------------------------------------------
function ecdhEncrypt(payload, peerPubkeyB64) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const shared = ecdh.computeSecret(Buffer.from(peerPubkeyB64, 'base64'));
  const key    = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), 'classguard-ha-join-v1', 32);
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct     = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    data:        ct.toString('base64'),
    iv:          iv.toString('base64'),
    tag:         cipher.getAuthTag().toString('base64'),
    senderPubkey: ecdh.getPublicKey('base64'),
  };
}

function ecdhDecrypt(enc, myEcdh) {
  const shared   = myEcdh.computeSecret(Buffer.from(enc.senderPubkey, 'base64'));
  const key      = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), 'classguard-ha-join-v1', 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

// ---------------------------------------------------------------------------
// pg_hba replication entry management — called by the join and delete
// handlers so standby IPs are always reflected in pg_hba.conf and Postgres
// is reloaded automatically.  No manual pg_hba edits ever needed.
//
// The file has two logical sections separated by the CLASSGUARD marker:
//   1. Static base rules (auth for localhost, app connections) — never touched
//   2. Dynamic replication entries — one hostssl line per standby IP
//
// The API rewrites only the replication section; the base never changes.
// PostgreSQL 15 doesn't support include_if_exists in pg_hba.conf (added in
// 16), so both sections live in one file managed here.
// ---------------------------------------------------------------------------
const PG_HBA_FILE   = '/app/pg_hba.conf';
const PG_HBA_MARKER = '# --- CLASSGUARD REPLICATION ENTRIES (auto-managed, do not edit below) ---';

const PG_HBA_BASE = `# ClassGuard PostgreSQL client authentication
# Managed by ClassGuard — the replication entries at the bottom are
# updated automatically by the API on node join/delete.

# Unix socket — trust for local tools (pg_isready, psql from containers)
local   all             all                                     trust

# IPv4/IPv6 localhost — trust (same-host API and migration containers)
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust

# Local replication — trust (pg_basebackup running on the same host)
local   replication     all                                     trust
host    replication     all             127.0.0.1/32            trust
host    replication     all             ::1/128                 trust

# All other TCP connections require scram-sha-256
host    all             all             all                     scram-sha-256

${PG_HBA_MARKER}
`;

function pgHbaUpdateReplication(ip, action) {
  // Read the current replication lines (below the marker)
  let existingEntries = [];
  try {
    const content  = fs.readFileSync(PG_HBA_FILE, 'utf8');
    const markerIdx = content.indexOf(PG_HBA_MARKER);
    if (markerIdx !== -1) {
      existingEntries = content.slice(markerIdx + PG_HBA_MARKER.length)
        .split('\n')
        .filter(l => l.match(/^hostssl\s+replication\s+replicator\s+/));
    }
  } catch (_) {}

  // Apply add/remove
  const entry    = `hostssl replication replicator ${ip}/32 scram-sha-256`;
  const filtered = existingEntries.filter(l => !l.includes(`replicator ${ip}/32`));
  const updated  = action === 'add' ? [...filtered, entry] : filtered;

  fs.writeFileSync(PG_HBA_FILE, PG_HBA_BASE + updated.join('\n') + (updated.length ? '\n' : ''));
}

async function pgHbaReload() {
  try {
    await pool.query('SELECT pg_reload_conf()');
  } catch (err) {
    console.warn('[ha] pg_reload_conf failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Self-registration — upserts this node on startup using node_id as the key
// ---------------------------------------------------------------------------

// Relays this node's own status to the primary when it can't write locally
// (a read-only standby) — same pattern as DNS log forwarding and VRRP
// state: read the primary's api_url + internal_secret from our own
// (replicated) data, POST to a primary-side endpoint that does the actual
// write. Used by both registerSelf() and the heartbeat interval below.
async function relayToPrimary(payload) {
  try {
    const { rows: [primary] } = await pool.query(
      `SELECT api_url FROM nodes WHERE ha_role = 'primary' AND is_active ORDER BY last_seen DESC LIMIT 1`
    );
    const { rows: [secretRow] } = await pool.query(`SELECT value FROM settings WHERE key = 'internal_secret'`);
    if (!primary?.api_url || !secretRow?.value) return;
    await axios.post(`${primary.api_url}/api/v1/ha/self-report`, payload, {
      headers: { 'x-internal-secret': secretRow.value },
      timeout: 5000,
    });
  } catch (err) {
    console.warn('[ha] relay to primary failed:', err.message);
  }
}

async function registerSelf() {
  const nodeId   = config.node.id;                     // NODE_ID env var || 'node1'
  const version  = config.version;
  const apiUrl   = config.appUrl;
  // NODE_ID, not process.env.HOSTNAME — every ClassGuard install's api
  // container has the same hardcoded Docker hostname, so a second node
  // writing that literal value would collide with the primary's own row.
  const hostname = nodeId;
  const haRole   = config.node.role === 'primary' ? 'primary' : 'standby';

  const { rows: [{ in_recovery }] } = await pool.query('SELECT pg_is_in_recovery() AS in_recovery')
    .catch(() => ({ rows: [{ in_recovery: false }] }));

  if (in_recovery) {
    return relayToPrimary({ node_id: nodeId, hostname, ha_role: haRole, api_url: apiUrl, version });
  }

  // ON CONFLICT on node_id, same as the join-flow's INSERT below — node_id
  // (from NODE_ID) is the real stable identity; hostname used to BE that
  // identity before NODE_ID existed, so a node registered under the old
  // scheme has a stale hostname that this upsert needs to correct, not just
  // match against. Conflicting on hostname instead (as this used to) means
  // a node_id match alone never updates anything — it throws a *separate*
  // nodes_node_id_unique violation not covered by this ON CONFLICT clause,
  // silently swallowed below, leaving the stale hostname stuck forever.
  await pool.query(
    `INSERT INTO nodes (node_id, hostname, ip, role, ha_role, api_url, version, last_seen, is_active)
     VALUES ($1, $2, '0.0.0.0', $3, $4, $5, $6, NOW(), true)
     ON CONFLICT (node_id) WHERE node_id IS NOT NULL DO UPDATE SET
       hostname  = EXCLUDED.hostname,
       ha_role   = EXCLUDED.ha_role,
       api_url   = EXCLUDED.api_url,
       version   = EXCLUDED.version,
       last_seen = NOW(),
       is_active = true`,
    [nodeId, hostname, config.node.role, haRole, apiUrl, version]
  ).catch(err => console.warn('[ha] self-register:', err.message));
}

// In-memory only, deliberately not persisted — this code only ever runs on
// a standby (read-only Postgres, can't write to `settings` itself), and a
// restart of this process resetting the countdown is the safe direction to
// fail in (re-confirm from zero) rather than the unsafe one (resume a stale
// countdown blindly). Cleared the instant either condition stops holding.
let autoPromoteCandidateSince = null;

// Tri-state: true = primary confirmed reachable (or inconclusive — treat
// the same, since "don't know" must never look like "confirmed down" to the
// caller), false = quorum-confirmed unreachable. With a 3rd+ node in the
// cluster, "quorum" means a strict majority of the OTHER nodes (excluding
// this one and the primary) independently agree they can't reach the
// primary either — one standby's own view of the network can't be trusted
// alone, since a partition that isolates just this node looks identical
// from here to the primary actually being down. With only 2 nodes total
// (no third node to ask), there's no quorum to take, and this necessarily
// falls back to this node's own observation alone — meaningfully less safe,
// which is exactly why the HA page's warning text calls that out and
// recommends a 3rd node specifically for this.
async function isPrimaryReachableByQuorum() {
  const { rows: [primary] } = await pool.query(
    `SELECT node_id, api_url FROM nodes WHERE ha_role = 'primary' AND is_active ORDER BY last_seen DESC LIMIT 1`
  ).catch(() => ({ rows: [] }));
  if (!primary?.api_url) return true; // no known primary at all -- ambiguous, never treat as confirmed-down

  let selfReachable = true;
  try {
    await axios.get(`${primary.api_url}/health`, { timeout: 3000 });
  } catch {
    selfReachable = false;
  }

  const { rows: peers } = await pool.query(
    `SELECT api_url FROM nodes WHERE node_id != $1 AND node_id != $2 AND api_url IS NOT NULL AND is_active = true`,
    [config.node.id, primary.node_id]
  ).catch(() => ({ rows: [] }));

  if (!peers.length) {
    // 2-node cluster -- no third opinion available, self-only judgment.
    return selfReachable;
  }

  const votes = await Promise.allSettled(
    peers.map(p => axios.get(`${p.api_url}/api/v1/ha/can-reach-primary`, { timeout: 3000 }).then(r => r.data.reachable))
  );
  const responded = votes
    .filter(v => v.status === 'fulfilled' && v.value !== null)
    .map(v => v.value);

  if (!responded.length) {
    // Every other node was itself unreachable for a vote -- can't form a
    // quorum, fall back to self-only (same reduced confidence as 2-node).
    return selfReachable;
  }

  const unreachableVotes = responded.filter(v => v === false).length + (selfReachable ? 0 : 1);
  const totalVotes        = responded.length + 1; // +1 for this node's own vote
  return unreachableVotes <= totalVotes / 2; // true unless a strict majority says "down"
}

async function notifyAutoPromotion({ ok, error }) {
  events.emit('system:ha_auto_promote', { ok, error: error || null, node_id: config.node.id, at: new Date().toISOString() });

  try {
    // Deliberately superadmins only, not the safety-alert recipient list --
    // this is an infra/ops event ("a database just auto-promoted itself"),
    // meaningless and alarming to a teacher or building admin who only
    // expects student-safety emails from that list.
    const { rows: admins } = await pool.query(`SELECT email FROM users WHERE role = 'superadmin'`);
    const recipients = admins.map(a => a.email).filter(Boolean);
    if (!recipients.length) return;

    const cfg = await mailer.getSmtpSettings();
    if (!cfg.smtp_host) return;

    const subject = ok
      ? `[ClassGuard] Node ${config.node.id} auto-promoted itself to primary`
      : `[ClassGuard] Auto-promotion attempt on ${config.node.id} FAILED`;
    const text = ok
      ? `This node held VRRP MASTER and could not reach the old primary for the configured grace period, so it auto-promoted itself to a writable primary.\n\n` +
        `If the old primary comes back online, check the HA page for a split-brain warning before assuming the two copies still agree -- they may have diverged during the outage.`
      : `This node attempted to auto-promote itself to primary but the attempt failed: ${error}\n\nIt remains a read-only standby. Manual intervention (HA page -> Promote) is likely needed.`;
    await mailer.sendMail({ to: recipients.join(','), subject, text });
  } catch (err) {
    console.error('[ha] auto-promote notification email failed:', err.message);
  }
}

// Called every heartbeat tick while this node is a standby. No-ops
// immediately unless an admin has explicitly opted in (see PUT
// /ha/auto-promote-config) -- this is off by default precisely because a
// 2-node cluster can't tell "primary is dead" apart from "I can't currently
// reach the primary" with full confidence; see isPrimaryReachableByQuorum.
async function maybeAutoPromote() {
  const { rows: [enabledRow] } = await pool.query(
    `SELECT value FROM settings WHERE key = 'ha_auto_promote_enabled'`
  ).catch(() => ({ rows: [] }));
  if (enabledRow?.value !== 'true') { autoPromoteCandidateSince = null; return; }

  const { rows: [selfRow] } = await pool.query(
    `SELECT vrrp_state FROM nodes WHERE node_id = $1`, [config.node.id]
  ).catch(() => ({ rows: [] }));
  if (selfRow?.vrrp_state !== 'MASTER') { autoPromoteCandidateSince = null; return; }

  const primaryLooksUp = await isPrimaryReachableByQuorum();
  if (primaryLooksUp) { autoPromoteCandidateSince = null; return; }

  if (!autoPromoteCandidateSince) autoPromoteCandidateSince = Date.now();

  const { rows: [graceRow] } = await pool.query(
    `SELECT value FROM settings WHERE key = 'ha_auto_promote_grace_seconds'`
  ).catch(() => ({ rows: [] }));
  const graceMs  = (parseInt(graceRow?.value, 10) || 300) * 1000;
  const elapsed  = Date.now() - autoPromoteCandidateSince;

  console.warn(`[ha] auto-promote candidate for ${Math.round(elapsed / 1000)}s / ${graceMs / 1000}s ` +
    `(holding VRRP MASTER, primary unreachable by quorum)`);

  if (elapsed < graceMs) return;

  autoPromoteCandidateSince = null; // reset regardless of outcome -- avoid an instant retry storm on failure
  console.error('[ha] AUTO-PROMOTING: grace period elapsed with VRRP MASTER held and primary unreachable');
  try {
    await promoteThisNode();
    await notifyAutoPromotion({ ok: true });
  } catch (err) {
    console.error('[ha] auto-promote failed:', err.message);
    await notifyAutoPromotion({ ok: false, error: err.message });
  }
}

function startHeartbeat() {
  registerSelf();
  setInterval(async () => {
    const { rows: [{ in_recovery }] } = await pool.query('SELECT pg_is_in_recovery() AS in_recovery')
      .catch(() => ({ rows: [{ in_recovery: false }] }));

    if (in_recovery) {
      await relayToPrimary({ node_id: config.node.id, version: config.version });
      return maybeAutoPromote();
    }

    await pool.query(
      `UPDATE nodes SET last_seen = NOW() WHERE node_id = $1`,
      [config.node.id]
    ).catch(() => {});

    // Split-brain probe — only meaningful for a node that believes it's an
    // active primary. The scenario this exists for: this node was the
    // primary, lost contact with the rest of the cluster, another node got
    // promoted in its place, and now this node is back — its own Postgres
    // never received that news (it's a separate, diverged writable cluster
    // now, not a standby of anything), so the only way it can find out is
    // by asking another node directly over the network. api_url is a
    // stable IP regardless of how stale this node's own ha_role data is.
    if (config.node.role === 'primary') {
      const { rows: peers } = await pool.query(
        `SELECT api_url FROM nodes WHERE node_id != $1 AND api_url IS NOT NULL`,
        [config.node.id]
      ).catch(() => ({ rows: [] }));
      let conflict = false;
      for (const { api_url } of peers) {
        try {
          const { data } = await axios.get(`${api_url}/api/v1/ha/role-check`, { timeout: 3000 });
          if (data.role === 'primary' && data.in_recovery === false) { conflict = true; break; }
        } catch { /* peer unreachable — not evidence either way, keep checking others */ }
      }
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('split_brain_detected', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [conflict ? 'true' : 'false']
      ).catch(() => {});
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// GET /api/v1/ha/nodes
// ---------------------------------------------------------------------------
router.get('/nodes', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT *, EXTRACT(EPOCH FROM (NOW() - last_seen)) AS seconds_since_seen
       FROM nodes ORDER BY ha_role, created_at`
    );

    const probed = await Promise.allSettled(
      rows.map(async (n) => {
        if (!n.api_url) return { ...n, healthy: false, probe: null };
        try {
          const r = await axios.get(`${n.api_url}/health`, { timeout: 3000 });
          return { ...n, healthy: true, probe: r.data };
        } catch {
          return { ...n, healthy: false, probe: null };
        }
      })
    );

    res.json(probed.map(r => r.status === 'fulfilled' ? r.value : { ...r.reason, healthy: false }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ha/nodes/:nodeId
router.get('/nodes/:nodeId', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM nodes WHERE node_id = $1', [req.params.nodeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ha/role-check — unauthenticated by design (no secrets in the
// response), called by OTHER nodes' heartbeats to detect a split-brain: two
// nodes both believing they're an active, writable primary at the same
// time. Must work even if the caller's view of this node is completely
// stale, so it can't depend on anything replicated.
// ---------------------------------------------------------------------------
router.get('/role-check', async (req, res) => {
  const { rows: [row] } = await pool.query('SELECT pg_is_in_recovery() AS in_recovery')
    .catch(() => ({ rows: [{ in_recovery: null }] }));
  res.json({ node_id: config.node.id, role: config.node.role, in_recovery: row.in_recovery });
});

// GET /api/v1/ha/split-brain-status — for the UI's warning banner
router.get('/split-brain-status', ...auth, async (req, res) => {
  const { rows: [row] } = await pool.query(`SELECT value FROM settings WHERE key = 'split_brain_detected'`);
  res.json({ detected: row?.value === 'true' });
});

// ---------------------------------------------------------------------------
// GET /api/v1/ha/can-reach-primary — quorum vote endpoint for auto-promotion
// below. Unauthenticated by design, same reasoning as /role-check: a
// standby asking its peers "can YOU reach the primary?" has to work even
// when nothing about the caller's identity can be verified against
// (possibly stale) replicated data. Reveals nothing sensitive, just a bool.
// ---------------------------------------------------------------------------
router.get('/can-reach-primary', async (req, res) => {
  try {
    const { rows: [primary] } = await pool.query(
      `SELECT api_url FROM nodes WHERE ha_role = 'primary' AND is_active ORDER BY last_seen DESC LIMIT 1`
    );
    if (!primary?.api_url) return res.json({ reachable: null });
    try {
      await axios.get(`${primary.api_url}/health`, { timeout: 3000 });
      res.json({ reachable: true });
    } catch {
      res.json({ reachable: false });
    }
  } catch (err) {
    res.json({ reachable: null });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ha/firewall-rules — localhost-only (same trust boundary as
// /update-status), polled every minute by the host-level update-watcher AND
// run once during install.sh, to keep ufw in sync with this node's actual
// role and the cluster's current membership. No relay-to-primary needed
// here unlike /update-status — `nodes`/`vpn_config` are plain replicated
// tables, readable locally on a standby same as the primary, only WRITES
// need the primary. Port 9999 (the VPN status port) deliberately never
// appears in this list -- it has no authentication and nothing outside
// this host needs to reach it directly.
// ---------------------------------------------------------------------------
router.get('/firewall-rules', async (req, res) => {
  try {
    const isPrimary = config.node.role === 'primary';

    // Universal -- every node runs frontend/dns/api regardless of role (DNS
    // is N-way redundant by design, not just a primary thing -- see
    // services/keepalived.js's header comment).
    const staticRules = [
      { port: '22',  proto: 'tcp', comment: 'SSH' },
      { port: '80',  proto: 'tcp', comment: 'HTTP / ACME' },
      { port: '443', proto: 'tcp', comment: 'HTTPS admin UI' },
      { port: '53',  proto: 'tcp', comment: 'DNS' },
      { port: '53',  proto: 'udp', comment: 'DNS' },
      { proto: 'vrrp', comment: 'VRRP heartbeat' },
    ];

    // NTP server (chrony) runs on every node, not just the primary -- same
    // no-leader-election reasoning as DNS (services/chrony.js) -- so this
    // check is unconditional on role, only on the feature's own setting.
    const { rows: [ntpCfg] } = await pool.query(
      `SELECT enabled FROM ntp_server_config LIMIT 1`
    ).catch(() => ({ rows: [{ enabled: false }] }));
    if (ntpCfg?.enabled) {
      staticRules.push({ port: '123', proto: 'udp', comment: 'NTP server' });
    }

    // FreeRADIUS runs on every node too (same reasoning as DNS/NTP -- the
    // VIP can float to whichever node is currently MASTER, so every node
    // needs to actually be reachable on these ports, not just the primary).
    // Gated on track_freeradius -- see infrastructure/freeradius/sync-freeradius.sh,
    // which uses the same flag to decide whether FreeRADIUS itself should be
    // installed/running on this node at all.
    const { rows: [radiusCfg] } = await pool.query(
      `SELECT track_freeradius FROM radius_ha_config LIMIT 1`
    ).catch(() => ({ rows: [{ track_freeradius: false }] }));
    if (radiusCfg?.track_freeradius) {
      staticRules.push({ port: '1812', proto: 'udp', comment: 'RADIUS auth' });
      staticRules.push({ port: '1813', proto: 'udp', comment: 'RADIUS accounting' });
    }

    let postgresPeerIps = [];

    if (isPrimary) {
      // Kea has no enable/disable toggle -- it's simply never started on a
      // standby (install.sh), so DHCP is unconditional for whichever node
      // is currently primary.
      staticRules.push({ port: '67',  proto: 'udp', comment: 'DHCPv4' });
      staticRules.push({ port: '547', proto: 'udp', comment: 'DHCPv6' });

      // VPN/SCEP containers are likewise never started on a standby, but
      // unlike Kea, VPN is genuinely optional even on the primary -- check
      // the real setting instead of assuming every primary wants it open.
      const { rows: [vpnCfg] } = await pool.query(
        `SELECT enabled FROM vpn_config LIMIT 1`
      ).catch(() => ({ rows: [{ enabled: false }] }));
      if (vpnCfg?.enabled) {
        staticRules.push({ port: '500',  proto: 'udp', comment: 'VPN IKE' });
        staticRules.push({ port: '4500', proto: 'udp', comment: 'VPN NAT-T' });
      }

      // Postgres only needs to accept inbound from whichever nodes are
      // currently active standbys -- not a fixed peer, so a 3rd/4th node
      // joining (or an old one being removed) changes this list without
      // any code change, same generalization keepalived.js already did
      // for VRRP priority. nodes.ip is just a stale '0.0.0.0' placeholder
      // (registerSelf() never actually populates it) -- api_url carries
      // the real reachable address, so pull the IP out of that instead.
      const { rows: standbys } = await pool.query(
        `SELECT api_url FROM nodes WHERE node_id != $1 AND ha_role = 'standby' AND is_active = true AND api_url IS NOT NULL`,
        [config.node.id]
      ).catch(() => ({ rows: [] }));
      postgresPeerIps = standbys
        .map(s => s.api_url.replace(/^https?:\/\//, '').split(/[:/]/)[0])
        .filter(Boolean);
    }

    res.json({ role: config.node.role, static_rules: staticRules, postgres_peer_ips: postgresPeerIps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET/PUT /api/v1/ha/auto-promote-config — the opt-in toggle + grace period
// for maybeAutoPromote() above. Off by default on every install; an admin
// has to deliberately turn this on after reading the warning on the HA
// page. Writes only succeed against the primary (it's a normal `settings`
// row, same as every other write in this app) -- in steady state the VIP
// already points at the primary, so this isn't a special case to handle.
// ---------------------------------------------------------------------------
router.get('/auto-promote-config', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('ha_auto_promote_enabled', 'ha_auto_promote_grace_seconds')`
  );
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({
    enabled:       byKey.ha_auto_promote_enabled === 'true',
    grace_seconds: parseInt(byKey.ha_auto_promote_grace_seconds, 10) || 300,
  });
});

router.put('/auto-promote-config', ...superauth, async (req, res) => {
  const { enabled, grace_seconds } = req.body;
  try {
    if (enabled !== undefined) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('ha_auto_promote_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [enabled ? 'true' : 'false']
      );
    }
    if (grace_seconds !== undefined) {
      const seconds = Math.max(60, parseInt(grace_seconds, 10) || 300);
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('ha_auto_promote_grace_seconds', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(seconds)]
      );
    }
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared by the manual /promote route and the auto-promotion heartbeat
// logic below. Throws on failure rather than returning an error shape —
// callers decide how to surface that (HTTP response vs. a log line + alert
// email).
async function promoteThisNode() {
  const { rows: [{ in_recovery }] } = await pool.query('SELECT pg_is_in_recovery() AS in_recovery');
  if (!in_recovery) {
    throw new Error('This node is already a writable primary');
  }

  await pool.query('SELECT pg_promote()');

  // pg_promote() returns almost immediately but recovery actually ending
  // lags a beat behind — poll briefly rather than assume it's instant.
  let promoted = false;
  for (let i = 0; i < 20; i++) {
    const { rows: [{ in_recovery: stillRecovering }] } = await pool.query('SELECT pg_is_in_recovery() AS in_recovery');
    if (!stillRecovering) { promoted = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!promoted) {
    throw new Error('pg_promote() did not complete in time — check postgres logs');
  }

  const nodeId = config.node.id;
  await pool.query(`UPDATE nodes SET ha_role = 'primary', is_active = true WHERE node_id = $1`, [nodeId]);
  // Purely informational on this node's own (now-authoritative) copy —
  // does NOT reach out and touch the old primary, which may not even be
  // reachable right now.
  await pool.query(`UPDATE nodes SET ha_role = 'demoted' WHERE node_id != $1 AND ha_role = 'primary'`, [nodeId]);

  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('pending_promotion_env_update', 'true')
     ON CONFLICT (key) DO UPDATE SET value = 'true'`
  );
}

// ---------------------------------------------------------------------------
// POST /api/v1/ha/promote — turns THIS standby into a real, writable
// primary. Must be called directly against the node being promoted —
// there's no live primary to relay through, that's the entire point of
// this endpoint. Irreversible, and dangerous if the old primary is still
// alive somewhere (split-brain) — the role-check probe in the heartbeat is
// the closest thing to a safety net for that, but it can only detect it
// after the fact, not prevent it, hence the required explicit confirm flag.
// ---------------------------------------------------------------------------
router.post('/promote', ...superauth, async (req, res) => {
  if (!req.body.confirm) {
    return res.status(400).json({ error: 'confirm:true is required — this is irreversible' });
  }
  try {
    await promoteThisNode();
    res.json({ promoted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ha/promote-status — local-only, polled by the host-level
// update-watcher to know when to flip NODE_ROLE/RUN_CRON_JOBS in .env and
// bring up the rest of the stack (Kea included, this node is a real primary
// now).
router.get('/promote-status', async (req, res) => {
  const { rows: [row] } = await pool.query(`SELECT value FROM settings WHERE key = 'pending_promotion_env_update'`);
  res.json({ pending: row?.value === 'true' });
});

// POST /api/v1/ha/promote-complete — local-only, clears the flag once the
// watcher has flipped .env and restarted the right containers.
router.post('/promote-complete', async (req, res) => {
  await pool.query(`DELETE FROM settings WHERE key = 'pending_promotion_env_update'`);
  res.json({ cleared: true });
});

// PUT /api/v1/ha/nodes/:nodeId/role
router.put('/nodes/:nodeId/role', ...auth, async (req, res) => {
  const { ha_role } = req.body;
  if (!['primary', 'standby', 'replica'].includes(ha_role)) {
    return res.status(400).json({ error: 'ha_role must be primary, standby, or replica' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE nodes SET ha_role = $1 WHERE node_id = $2 RETURNING *',
      [ha_role, req.params.nodeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/ha/nodes/:nodeId/priority — reorders a node's place in the
// VRRP failover election (see services/keepalived.js). Independent of
// ha_role (the Postgres replication role) — priority only governs which
// live node wins the VIP, it does not touch database write access.
router.put('/nodes/:nodeId/priority', ...auth, async (req, res) => {
  const failoverPriority = parseInt(req.body.failover_priority, 10);
  if (!Number.isInteger(failoverPriority) || failoverPriority < 1 || failoverPriority > 255) {
    return res.status(400).json({ error: 'failover_priority must be an integer between 1 and 255 (VRRP\'s own valid range)' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE nodes SET failover_priority = $1 WHERE node_id = $2 RETURNING *',
      [failoverPriority, req.params.nodeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/ha/nodes/:nodeId
router.delete('/nodes/:nodeId', ...auth, async (req, res) => {
  if (req.params.nodeId === config.node.id) {
    return res.status(400).json({ error: 'Cannot remove the current node' });
  }
  try {
    const { rows } = await pool.query(
      'DELETE FROM nodes WHERE node_id = $1 RETURNING node_id, api_url', [req.params.nodeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });

    // Remove the standby's pg_hba replication entry so it can no longer
    // connect for replication after being removed from the cluster.
    const deletedApiUrl = rows[0].api_url;
    if (deletedApiUrl) {
      try {
        const ip = new URL(deletedApiUrl).hostname;
        pgHbaUpdateReplication(ip, 'remove');
        await pgHbaReload();
      } catch (_) {}
    }

    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Invite tokens — admin creates, new server consumes
// ---------------------------------------------------------------------------

// GET /api/v1/ha/invites
router.get('/invites', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.full_name AS created_by_name
       FROM ha_invite_tokens i
       LEFT JOIN users u ON u.id = i.created_by
       WHERE i.used_at IS NULL AND i.expires_at > NOW()
       ORDER BY i.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/ha/invites
router.post('/invites', ...auth, async (req, res) => {
  const { label, ha_role = 'standby', expires_hours = 168 } = req.body; // 7 days default
  const token = crypto.randomBytes(32).toString('hex');
  try {
    const { rows } = await pool.query(
      `INSERT INTO ha_invite_tokens (token, label, ha_role, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::interval)
       RETURNING *`,
      [token, label || null, ha_role, req.user.id, expires_hours]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/ha/invites/:id
router.delete('/invites/:id', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM ha_invite_tokens WHERE id = $1 AND used_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invite not found or already used' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/ha/join — called by a new server to join the cluster.
// No JWT auth — uses the invite token instead.
// ---------------------------------------------------------------------------
router.post('/join', async (req, res) => {
  const { token, node_id, hostname, api_url, ha_role, request_replica, version } = req.body;
  if (!token || !node_id || !api_url) {
    return res.status(400).json({ error: 'token, node_id, and api_url are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Atomically claim the token via UPDATE...RETURNING rather than SELECT then
    // UPDATE — under concurrent /join calls with the same token, Postgres
    // serializes the UPDATE so only one request can ever see used_at IS NULL.
    const { rows: inv } = await client.query(
      `UPDATE ha_invite_tokens SET used_at = NOW()
       WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING *`,
      [token]
    );
    if (!inv.length) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Invalid, expired, or already-used invite token' });
    }
    const invite = inv[0];

    // A freshly-joined node always lands at the bottom of the failover
    // order by default — 10 below whatever the lowest active node's
    // priority currently is (floored at 10) — so it can never accidentally
    // outrank the existing primary just by joining. An admin can re-rank it
    // afterward via PUT /nodes/:nodeId/priority.
    const { rows: [{ min_priority }] } = await client.query(
      `SELECT COALESCE(MIN(failover_priority), 110) AS min_priority FROM nodes WHERE is_active = true`
    );
    const defaultPriority = Math.max(10, min_priority - 10);
    const failoverPriority = req.body.failover_priority ?? defaultPriority;

    const { rows: nodeRows } = await client.query(
      `INSERT INTO nodes (node_id, hostname, ip, role, ha_role, api_url, version, last_seen, is_active, failover_priority)
       VALUES ($1, $2, '0.0.0.0', 'secondary', $3, $4, $5, NOW(), true, $6)
       ON CONFLICT (node_id) WHERE node_id IS NOT NULL DO UPDATE SET
         hostname  = EXCLUDED.hostname,
         ha_role   = EXCLUDED.ha_role,
         api_url   = EXCLUDED.api_url,
         version   = EXCLUDED.version,
         last_seen = NOW(),
         is_active = true
       RETURNING *`,
      [node_id, hostname || node_id, ha_role || invite.ha_role, api_url, version || 'unknown', failoverPriority]
    );

    await client.query(
      `UPDATE ha_invite_tokens SET used_by_node = $1 WHERE id = $2`,
      [nodeRows[0].id, invite.id]
    );

    // Optionally provision Postgres replication for the joining node in the
    // same transaction.
    let replication = null;
    if (request_replica) {
      // `replicator` is one shared role used by every standby, not one per
      // node — rotating its password on every /join (the original design)
      // broke every OTHER already-connected standby's primary_conninfo the
      // moment a second node joined. Create once, reuse forever; never
      // rotate implicitly. Stored in settings (replicates like any other
      // row) so it's retrievable later instead of write-only via ALTER ROLE.
      let { rows: [secretRow] } = await client.query(`SELECT value FROM settings WHERE key = 'replicator_password'`);
      let password = secretRow?.value;
      if (!password) {
        password = crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
        await client.query(
          `INSERT INTO settings (key, value) VALUES ('replicator_password', $1) ON CONFLICT (key) DO NOTHING`,
          [password]
        );
        // Re-read in case of a race with a concurrent first join — the
        // loser here must use the winner's stored value, not its own.
        ({ rows: [secretRow] } = await client.query(`SELECT value FROM settings WHERE key = 'replicator_password'`));
        password = secretRow.value;
      }

      const { rows: roleRows } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'replicator'`);
      if (!roleRows.length) {
        await client.query(`CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${password}'`);
      }

      // A dedicated replication slot per node retains WAL for that specific
      // standby through a transient disconnect, instead of it being
      // recycled and forcing a full re-basebackup on reconnect.
      const slotName = `cg_${node_id}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63);
      const { rows: slotRows } = await client.query(`SELECT 1 FROM pg_replication_slots WHERE slot_name = $1`, [slotName]);
      if (!slotRows.length) {
        await client.query(`SELECT pg_create_physical_replication_slot($1)`, [slotName]);
      }

      let primaryHost;
      try { primaryHost = new URL(config.appUrl).hostname; } catch { primaryHost = config.appUrl; }
      // appDbPassword is this primary's actual `classguard` Postgres role
      // password — pg_basebackup replicates that role (and its password)
      // verbatim, so once the joining node becomes a standby, ITS OWN
      // previously-generated DB_PASSWORD in its own .env stops working.
      // Handed back so the joining node's setup script can sync its .env
      // to match before it ever tries to connect.
      replication = {
        host: primaryHost, port: 5432, user: 'replicator', password, slot: slotName,
        appDbPassword: process.env.DB_PASSWORD,
      };

      // Add pg_hba entry for this standby so pg_basebackup and ongoing
      // streaming replication are allowed through.
      let joiningIp = null;
      try { joiningIp = new URL(api_url).hostname; } catch (_) {}
      if (joiningIp) {
        pgHbaUpdateReplication(joiningIp, 'add');
        // Reload happens after COMMIT so the role/slot exist before any
        // connection attempt from the joining node.
      }
    }

    await client.query('COMMIT');

    // Reload pg_hba outside the transaction — the replicator role and slot
    // must be committed before Postgres evaluates the new hba rule.
    if (replication) await pgHbaReload();
    // Every node independently generates its own JWT_SECRET at install time
    // (see install.sh) — with no sync step, a session minted on this primary
    // was never actually valid on the joining node, so the moment VRRP fails
    // over every logged-in user gets silently bounced to the login screen.
    // Handed back unconditionally (not gated behind request_replica) so any
    // join — DB-replicating or not — ends up able to validate this primary's
    // tokens.
    //
    // EXTENSION_SIGNING_KEY (chrome-extension/scripts/generate-key.js) is
    // optional — undefined on any install that's never run the one-time
    // keygen — but when it IS set, every node needs the identical value or
    // extension-builder would mint a different extension ID on that node,
    // silently forking the auto-update story between nodes the moment
    // anyone built the extension there.
    const secrets = {
      jwtSecret:           process.env.JWT_SECRET,
      extensionSigningKey: process.env.EXTENSION_SIGNING_KEY || null,
      replication,
    };

    // If the joining node sent an ephemeral ECDH public key, encrypt the
    // secrets payload so credentials never travel plaintext.  Fall back to
    // plaintext only for older nodes that don't send a pubkey.
    if (req.body.pubkey) {
      const encrypted = ecdhEncrypt(secrets, req.body.pubkey);
      res.status(201).json({ joined: true, node: nodeRows[0], encrypted });
    } else {
      res.status(201).json({ joined: true, node: nodeRows[0], ...secrets });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/ha/join-cluster — admin-driven UI action run on THIS node, to
// join an existing primary's cluster using an invite token generated there.
// Complements /join (which the PRIMARY exposes for a node to call into) by
// giving the JOINING node's own admin a button in their own UI instead of
// needing shell access to run a docker-compose command with env vars.
// ---------------------------------------------------------------------------
router.post('/join-cluster', ...superauth, async (req, res) => {
  const { primary_url, token, request_replica, request_active_standby } = req.body;
  if (!primary_url || !token) {
    return res.status(400).json({ error: 'primary_url and token are required' });
  }
  const cleanUrl = primary_url.trim().replace(/\/+$/, '');
  try {
    // NODE_ID (not process.env.HOSTNAME) is what's actually unique here —
    // every ClassGuard install's api container has the same Docker-level
    // hostname (hardcoded in docker-compose.yml), so a second node's join
    // would otherwise collide with the primary's own row on nodes'
    // hostname unique constraint, regardless of node_id differing.

    // Generate an ephemeral ECDH keypair so the primary can encrypt its
    // response — secrets never travel plaintext over the wire.
    const joinEcdh  = crypto.createECDH('prime256v1');
    joinEcdh.generateKeys();
    const joinPubkey = joinEcdh.getPublicKey('base64');

    const { data } = await axios.post(`${cleanUrl}/api/v1/ha/join`, {
      token,
      node_id:  config.node.id,
      hostname: config.node.id,
      api_url:  config.appUrl,
      version:  config.version,
      request_replica: !!request_replica,
      pubkey:   joinPubkey,
    }, { timeout: 8000 });

    // Decrypt the secrets payload if the primary used ECDH encryption.
    // Fall back to reading plaintext fields for older primaries.
    const secrets = data?.encrypted
      ? ecdhDecrypt(data.encrypted, joinEcdh)
      : { jwtSecret: data?.jwtSecret, extensionSigningKey: data?.extensionSigningKey, replication: data?.replication };
    const { jwtSecret, extensionSigningKey, replication: repConfig } = secrets;

    // Reflect the role the invite assigned us locally too, so this node's
    // own self-registration heartbeat (registerSelf) stays consistent with
    // what the primary now has on record for it.
    if (data?.node?.ha_role) {
      await pool.query(
        `UPDATE nodes SET ha_role = $1 WHERE node_id = $2`,
        [data.node.ha_role, config.node.id]
      ).catch(() => {});
    }

    // We can't safely run docker/volume commands, or write this host's .env,
    // from inside this container (that needs Docker-socket/filesystem access,
    // a real security tradeoff we don't make implicitly) — so instead of
    // doing the pg_basebackup ourselves, hand back a ready-to-run script
    // with the credentials already filled in. One paste on this server
    // replaces the manual multi-step dance — including the .env role/cron
    // flags and DB password resync that pg_basebackup silently requires
    // (it replicates the actual Postgres role password, so this node's own
    // previously-generated DB_PASSWORD stops working the moment it becomes
    // a standby), found by hand the first time this was done for real.
    let setupScript = null;
    const lines = ['cd /opt/classguard'];

    // Tracks which containers need restarting purely because a secret was
    // patched into .env — separate from whatever the replication branch
    // below already brings up, so we don't double-issue `docker compose up`
    // for the same service.
    const restartServices = new Set();

    // Patched in regardless of whether DB replication was requested — a
    // mismatched JWT_SECRET breaks session continuity on failover even for
    // a node that isn't a DB replica.
    if (jwtSecret) {
      lines.push(`sed -i "s/^JWT_SECRET=.*/JWT_SECRET=${jwtSecret}/" .env`);
      restartServices.add('api');
    }
    // Full base64 (unfiltered RSA key, unlike the alphanumeric-only
    // JWT_SECRET/DB_PASSWORD) — can contain '/', so this needs a delimiter
    // sed won't confuse with the substitution syntax. '#' never appears in
    // base64 output.
    if (extensionSigningKey) {
      lines.push(`sed -i "s#^EXTENSION_SIGNING_KEY=.*#EXTENSION_SIGNING_KEY=${extensionSigningKey}#" .env`);
      restartServices.add('extension-builder');
    }

    if (repConfig) {
      const { host, port, user, password, slot, appDbPassword } = repConfig;
      lines.push(
        'docker compose down',
        'docker volume rm classguard_postgres-data',
        'docker volume create classguard_postgres-data',
        'docker run --rm \\',
        '  -v classguard_postgres-data:/var/lib/postgresql/data \\',
        `  -e PGPASSWORD='${password}' \\`,
        '  -e PGSSLMODE=require \\',
        '  timescale/timescaledb:latest-pg15 \\',
        `  pg_basebackup -h ${host} -p ${port} -U ${user} -D /var/lib/postgresql/data -Fp -Xs -P -R${slot ? ` -S ${slot}` : ''}`,
      );
      if (appDbPassword) {
        lines.push(
          `sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=${appDbPassword}/" .env`,
          `sed -i "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://classguard:${appDbPassword}@postgres:5432/classguard#" .env`,
        );
      }
      if (request_active_standby) {
        lines.push(
          'sed -i "s/^NODE_ROLE=.*/NODE_ROLE=standby/" .env',
          'sed -i "s/^RUN_CRON_JOBS=.*/RUN_CRON_JOBS=false/" .env',
          'sed -i "s/^NODE_ID=.*/NODE_ID=$(hostname)/" .env',
          'docker compose build api dns frontend migrate',
          'docker compose up -d redis api dns frontend',
        );
        restartServices.delete('api'); // already covered by the line above
      } else {
        lines.push('docker compose up -d postgres');
      }
      if (restartServices.size) {
        lines.push(`docker compose up -d ${[...restartServices].join(' ')}`);
      }
    } else if (restartServices.size) {
      // No DB replication requested — still need to (re)start whichever
      // containers consume a secret that was just patched into .env.
      lines.push(`docker compose up -d ${[...restartServices].join(' ')}`);
    }

    if (lines.length > 1) setupScript = lines.join('\n');

    res.json({ joined: true, primary_url: cleanUrl, node: data.node, setup_script: setupScript });
  } catch (err) {
    const message = err.response?.data?.error || err.message;
    res.status(err.response?.status && err.response.status < 500 ? err.response.status : 502)
      .json({ error: `Failed to join ${cleanUrl}: ${message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/ha/vrrp-notify — called by keepalived's notify.sh (see
// services/keepalived.js's generateNotifyScript) on every MASTER/BACKUP/FAULT
// transition, so the Cluster Nodes list reflects which node actually holds
// the VIP right now. Deliberately separate from ha_role (the Postgres
// replication role) — a VRRP failover does NOT promote a standby's database;
// that's still a manual step, so we never imply otherwise here.
// ---------------------------------------------------------------------------
router.post('/vrrp-notify', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { state, node_id } = req.body;
  if (!state || !node_id) {
    return res.status(400).json({ error: 'state and node_id are required' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE nodes SET vrrp_state = $1, last_seen = NOW() WHERE node_id = $2 RETURNING node_id, vrrp_state`,
      [state, node_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json({ updated: true, ...rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/ha/vrrp-local — called by THIS node's own notify.sh, no
// internal-secret needed (bound to 127.0.0.1 only, same as the health check
// keepalived already uses). Exists because notify.sh has no way to read the
// *primary's* INTERNAL_SECRET — every node generates its own independently
// at install time, so a standby's notify.sh sending its own secret directly
// to /vrrp-notify would just get rejected. This node's own API already has
// the correct (replicated) secret on hand, same pattern as DNS log
// forwarding — so do the relay here instead of in the shell script.
// ---------------------------------------------------------------------------
router.post('/vrrp-local', async (req, res) => {
  const { state } = req.body;
  if (!state) return res.status(400).json({ error: 'state is required' });

  const nodeId = config.node.id;
  try {
    if (config.node.role === 'primary') {
      await pool.query(`UPDATE nodes SET vrrp_state = $1, last_seen = NOW() WHERE node_id = $2`, [state, nodeId]);
      return res.json({ updated: true });
    }

    const { rows: [primary] } = await pool.query(
      `SELECT api_url FROM nodes WHERE ha_role = 'primary' AND is_active ORDER BY last_seen DESC LIMIT 1`
    );
    const { rows: [secretRow] } = await pool.query(`SELECT value FROM settings WHERE key = 'internal_secret'`);
    if (!primary?.api_url || !secretRow?.value) {
      return res.status(503).json({ error: 'primary/secret not found in replicated data yet' });
    }

    await axios.post(`${primary.api_url}/api/v1/ha/vrrp-notify`, { state, node_id: nodeId }, {
      headers: { 'x-internal-secret': secretRow.value },
      timeout: 5000,
    });
    res.json({ forwarded: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/ha/self-report — a standby's registerSelf()/heartbeat relay
// target (see relayToPrimary above) for whatever it can't write to its own
// read-only Postgres: version, last_seen, etc. Only touches fields actually
// provided, so a heartbeat tick (which only sends node_id + version) never
// clobbers hostname/ha_role/api_url with nulls.
// ---------------------------------------------------------------------------
router.post('/self-report', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { node_id, hostname, ha_role, api_url, version } = req.body;
  if (!node_id) return res.status(400).json({ error: 'node_id is required' });
  try {
    const { rows } = await pool.query(
      `UPDATE nodes SET
         hostname  = COALESCE($2, hostname),
         ha_role   = COALESCE($3, ha_role),
         api_url   = COALESCE($4, api_url),
         version   = COALESCE($5, version),
         last_seen = NOW(),
         is_active = true
       WHERE node_id = $1
       RETURNING node_id`,
      [node_id, hostname || null, ha_role || null, api_url || null, version || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json({ updated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ha/check-update — compares this node's version against the
// VERSION file on GitHub's main branch, and surfaces the relevant
// CHANGELOG.md section if an update is available. Pure read, no relay
// needed — every node can check this independently.
// ---------------------------------------------------------------------------
const GITHUB_REPO = 'manderson20/classguard';

// This host's outbound DNS resolution to api.github.com has been observed to
// fail intermittently (EAI_AGAIN) even at the OS level, independent of
// Docker — a network-level blip, not a GitHub or ClassGuard issue. One retry
// after a short delay is enough to ride out a single bad lookup.
async function githubGetWithRetry(url, opts, attempts = 2) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await axios.get(url, opts);
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

router.get('/check-update', ...auth, async (req, res) => {
  try {
    const { rows: [tokenRow] } = await pool.query(`SELECT value FROM settings WHERE key = 'github_update_token'`);
    // The classguard repo is private — GitHub's Contents API returns a plain
    // 404 for an unauthenticated request to a private repo (same as a repo
    // that doesn't exist at all), which silently broke this whole check
    // with no indication of why. A token with read access to the repo fixes
    // it; without one, surface that clearly instead of a bare 404.
    const githubHeaders = tokenRow?.value
      ? { Authorization: `Bearer ${tokenRow.value}` }
      : {};

    const { data: latestVersionRaw } = await githubGetWithRetry(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/VERSION?ref=main`,
      { headers: { Accept: 'application/vnd.github.raw', ...githubHeaders }, timeout: 8000 }
    );
    const latestVersion = String(latestVersionRaw).trim();

    let changelog = null;
    try {
      const { data: changelogRaw } = await githubGetWithRetry(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/CHANGELOG.md?ref=main`,
        { headers: { Accept: 'application/vnd.github.raw', ...githubHeaders }, timeout: 8000 }
      );
      const escaped = latestVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = String(changelogRaw).match(new RegExp(`## \\[${escaped}\\][^]*?(?=\\n## \\[|$)`));
      changelog = match ? match[0].trim() : null;
    } catch { /* changelog is a nice-to-have, not fatal if GitHub rate-limits this second call */ }

    res.json({
      current_version: config.version,
      latest_version: latestVersion,
      update_available: latestVersion !== config.version,
      changelog,
    });
  } catch (err) {
    const isAuthError = err.response?.status === 404 || err.response?.status === 401;
    const hint = isAuthError
      ? ' — the classguard repo is private; add a GitHub token with read access to it below.'
      : '';
    res.status(502).json({ error: `Failed to check GitHub: ${err.message}${hint}`, needs_token: isAuthError });
  }
});

// Looks up the primary's api_url + internal_secret from our own (replicated)
// data — same lookup used by update-status/update-complete above. Returns
// null if either isn't replicated yet (primary not joined, or too new).
async function findPrimary() {
  const { rows: [primary] } = await pool.query(
    `SELECT api_url FROM nodes WHERE ha_role = 'primary' AND is_active ORDER BY last_seen DESC LIMIT 1`
  );
  const { rows: [secretRow] } = await pool.query(`SELECT value FROM settings WHERE key = 'internal_secret'`);
  if (!primary?.api_url || !secretRow?.value) return null;
  return { apiUrl: primary.api_url, secret: secretRow.value };
}

// Actual write, run only on the primary (called either directly below, when
// we already are the primary, or by the *-for relay target a standby hits).
async function doScheduleUpdate(scheduledAt, targetVersion, requestedBy) {
  const { rows: nodeRows } = await pool.query(`SELECT node_id FROM nodes WHERE is_active = true`);
  const results = [];
  for (const { node_id } of nodeRows) {
    const { rows } = await pool.query(
      `INSERT INTO update_schedule (node_id, target_version, scheduled_at, requested_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (node_id) WHERE status IN ('pending', 'in_progress')
       DO UPDATE SET scheduled_at = EXCLUDED.scheduled_at, target_version = EXCLUDED.target_version
       RETURNING *`,
      [node_id, targetVersion, scheduledAt, requestedBy || null]
    );
    results.push(rows[0]);
  }
  return results;
}

async function doCancelSchedule(nodeId) {
  const { rows } = await pool.query(
    `UPDATE update_schedule SET status = 'failed', log = 'Cancelled by admin', completed_at = NOW()
     WHERE node_id = $1 AND status IN ('pending', 'in_progress') RETURNING id`,
    [nodeId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// POST /api/v1/ha/schedule-update — update_schedule only exists on the
// primary's writable DB, but an admin can be logged into ANY node's UI
// (e.g. browsed directly to a standby's IP rather than the VRRP VIP) — so
// this has to relay to the primary exactly like update-status/update-complete
// do, instead of assuming "this request landed on the primary" like it used
// to. Without this, scheduling from a standby's UI hit that standby's own
// read-only replica and failed with "cannot execute INSERT in a read-only
// transaction".
// ---------------------------------------------------------------------------
router.post('/schedule-update', ...superauth, async (req, res) => {
  const { scheduled_at, target_version } = req.body;
  if (!scheduled_at || !target_version) {
    return res.status(400).json({ error: 'scheduled_at and target_version are required' });
  }
  try {
    if (config.node.role === 'primary') {
      const results = await doScheduleUpdate(scheduled_at, target_version, req.user.userId);
      return res.status(201).json({ scheduled: results });
    }

    const primary = await findPrimary();
    if (!primary) {
      return res.status(503).json({ error: 'Primary node not found in replicated data yet — try again shortly.' });
    }
    const { data } = await axios.post(`${primary.apiUrl}/api/v1/ha/schedule-update-for`,
      { scheduled_at, target_version, requested_by: req.user.userId },
      { headers: { 'x-internal-secret': primary.secret }, timeout: 10000 }
    );
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/ha/schedule-update-for — internal-secret only, the primary-side
// target of the relay above
router.post('/schedule-update-for', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { scheduled_at, target_version, requested_by } = req.body;
  if (!scheduled_at || !target_version) {
    return res.status(400).json({ error: 'scheduled_at and target_version are required' });
  }
  try {
    const results = await doScheduleUpdate(scheduled_at, target_version, requested_by);
    res.status(201).json({ scheduled: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/ha/schedule-update/:nodeId — cancel a pending/in_progress
// schedule for one node. Same relay requirement as POST above.
router.delete('/schedule-update/:nodeId', ...superauth, async (req, res) => {
  try {
    if (config.node.role === 'primary') {
      const rows = await doCancelSchedule(req.params.nodeId);
      if (!rows.length) return res.status(404).json({ error: 'No active schedule for that node' });
      return res.json({ cancelled: true });
    }

    const primary = await findPrimary();
    if (!primary) {
      return res.status(503).json({ error: 'Primary node not found in replicated data yet — try again shortly.' });
    }
    const { data } = await axios.delete(`${primary.apiUrl}/api/v1/ha/schedule-update-for/${req.params.nodeId}`,
      { headers: { 'x-internal-secret': primary.secret }, timeout: 10000 }
    );
    res.json(data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/ha/schedule-update-for/:nodeId — internal-secret only, the
// primary-side target of the relay above
router.delete('/schedule-update-for/:nodeId', authenticate, requireMinRole('superadmin'), async (req, res) => {
  try {
    const rows = await doCancelSchedule(req.params.nodeId);
    if (!rows.length) return res.status(404).json({ error: 'No active schedule for that node' });
    res.json({ cancelled: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ha/update-schedule — cluster-wide view for the UI
router.get('/update-schedule', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, n.hostname FROM update_schedule s
       JOIN nodes n ON n.node_id = s.node_id
       ORDER BY s.created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ha/update-status — called by THIS node's own host-level
// update-watcher (see infrastructure/update-watcher), no auth needed
// (localhost-only trust boundary, same as /vrrp-local and the keepalived
// health check). Returns this node's own pending update, if any —
// relayed through the primary if this node is a standby, since
// update_schedule only exists on the primary's writable DB.
// ---------------------------------------------------------------------------
router.get('/update-status', async (req, res) => {
  const nodeId = config.node.id;
  try {
    if (config.node.role === 'primary') {
      const { rows } = await pool.query(
        `SELECT * FROM update_schedule WHERE node_id = $1 AND status IN ('pending','in_progress')
         ORDER BY scheduled_at LIMIT 1`,
        [nodeId]
      );
      return res.json({ pending: rows[0] || null });
    }

    const primary = await findPrimary();
    if (!primary) return res.json({ pending: null });
    const { data } = await axios.get(`${primary.apiUrl}/api/v1/ha/update-status-for/${nodeId}`, {
      headers: { 'x-internal-secret': primary.secret },
      timeout: 5000,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ha/update-status-for/:nodeId — internal-secret only, the primary-side
// target of the relay above
router.get('/update-status-for/:nodeId', authenticate, requireMinRole('superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM update_schedule WHERE node_id = $1 AND status IN ('pending','in_progress')
       ORDER BY scheduled_at LIMIT 1`,
      [req.params.nodeId]
    );
    res.json({ pending: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/ha/update-complete — called by THIS node's own update-watcher
// after running (or attempting) the actual update, no auth needed (same
// localhost trust boundary). Relayed through the primary if this node is a
// standby. Body: { status: 'in_progress'|'completed'|'failed', log }
// ---------------------------------------------------------------------------
router.post('/update-complete', async (req, res) => {
  const { status, log } = req.body;
  const nodeId = config.node.id;
  if (!status) return res.status(400).json({ error: 'status is required' });
  // Computed here, not reused inline in SQL — node-pg infers $1 as varchar
  // from "status = $1" but text from an explicit "$1::text" cast elsewhere
  // in the same query, and Postgres rejects that as an inconsistent type
  // for the same parameter even though varchar/text are trivially coercible.
  const isTerminal = status === 'completed' || status === 'failed';
  try {
    if (config.node.role === 'primary') {
      await pool.query(
        `UPDATE update_schedule SET status = $1, log = $2,
           completed_at = CASE WHEN $4 THEN NOW() ELSE completed_at END
         WHERE node_id = $3 AND status IN ('pending','in_progress')`,
        [status, log || null, nodeId, isTerminal]
      );
      return res.json({ updated: true });
    }

    const primary = await findPrimary();
    if (!primary) {
      return res.status(503).json({ error: 'primary/secret not found in replicated data yet' });
    }
    await axios.post(`${primary.apiUrl}/api/v1/ha/update-complete-for/${nodeId}`, { status, log }, {
      headers: { 'x-internal-secret': primary.secret },
      timeout: 5000,
    });
    res.json({ forwarded: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/ha/update-complete-for/:nodeId — internal-secret only, the
// primary-side target of the relay above
router.post('/update-complete-for/:nodeId', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { status, log } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });
  const isTerminal = status === 'completed' || status === 'failed';
  try {
    await pool.query(
      `UPDATE update_schedule SET status = $1, log = $2,
         completed_at = CASE WHEN $4 THEN NOW() ELSE completed_at END
       WHERE node_id = $3 AND status IN ('pending','in_progress')`,
      [status, log || null, req.params.nodeId, isTerminal]
    );
    res.json({ updated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ha/summary
// ---------------------------------------------------------------------------
router.get('/summary', ...auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ha_role,
              COUNT(*) AS count,
              COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '60 seconds') AS online
       FROM nodes GROUP BY ha_role`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ha/db-replication
// Surfaces PostgreSQL streaming replication status. ClassGuard does not set up
// or manage replication itself (that's pg_auto_failover/Patroni's job at the
// infra level) — this just reports what's there so admins can see the SPOF
// risk and replica health at a glance.
// ---------------------------------------------------------------------------
router.get('/db-replication', ...auth, async (req, res) => {
  try {
    const { rows: [{ in_recovery }] } = await pool.query('SELECT pg_is_in_recovery() AS in_recovery');

    if (in_recovery) {
      const { rows: [standby] } = await pool.query(
        `SELECT pg_last_wal_receive_lsn()        AS receive_lsn,
                pg_last_wal_replay_lsn()          AS replay_lsn,
                pg_last_xact_replay_timestamp()   AS last_replay_at,
                EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp())) AS replay_lag_seconds`
      );
      return res.json({ role: 'standby', standby, replicas: [] });
    }

    const { rows: replicas } = await pool.query(
      `SELECT application_name, client_addr, state, sync_state,
              pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn)   AS sent_lag_bytes,
              pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
              write_lag, flush_lag, replay_lag
       FROM pg_stat_replication
       ORDER BY application_name`
    );
    res.json({ role: 'primary', replicas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// VRRP / Virtual IP config — the single floating address the whole cluster
// answers on (web UI, and FreeRADIUS too on nodes that run it). Shared with
// the RADIUS page's HA & Config tab since it's the same underlying VIP.
// ---------------------------------------------------------------------------

// GET /api/v1/ha/vrrp
router.get('/vrrp', ...auth, async (req, res) => {
  try {
    const cfg = await keepalived.getHaConfig();
    res.json(keepalived.redactHaConfig(cfg));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ha/vrrp-sync — localhost-only, same trust boundary as
// /firewall-rules and /update-status, polled by infrastructure/keepalived/
// sync-keepalived.sh. Returns THIS node's own rendered keepalived.conf +
// notify.sh, self-scoped rather than the admin-facing /radius/config-bundle
// (which returns every node's files at once for manual download). `enabled`
// mirrors nginx.conf's own existing rule: no real VIP configured yet means
// this is a single-node install that was never meant to run keepalived at
// all, not an error.
// ---------------------------------------------------------------------------
router.get('/vrrp-sync', async (req, res) => {
  try {
    const cfg = await keepalived.getHaConfig();
    if (!cfg.vip_address) return res.json({ enabled: false });

    const nodes   = await keepalived.getNodes();
    const nodeRow = nodes.find(n => n.node_id === config.node.id);
    if (!nodeRow) return res.json({ enabled: false });

    res.json({
      enabled: true,
      conf:    keepalived.generateKeepalived(cfg, nodeRow),
      notify:  keepalived.generateNotifyScript(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/ha/vrrp
router.put('/vrrp', ...superauth, async (req, res) => {
  const { vip_address, vip_prefix_len, vip_interface, vrrp_instance_name,
          vrrp_virtual_router_id, vrrp_auth_password, vrrp_advert_int,
          priority_primary, priority_secondary, track_freeradius,
          track_classguard_api } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE radius_ha_config SET
         vip_address            = COALESCE($1::inet, vip_address),
         vip_prefix_len          = COALESCE($2, vip_prefix_len),
         vip_interface           = COALESCE($3, vip_interface),
         vrrp_instance_name      = COALESCE($4, vrrp_instance_name),
         vrrp_virtual_router_id  = COALESCE($5, vrrp_virtual_router_id),
         vrrp_auth_password      = COALESCE($6, vrrp_auth_password),
         vrrp_advert_int         = COALESCE($7, vrrp_advert_int),
         priority_primary        = COALESCE($8, priority_primary),
         priority_secondary      = COALESCE($9, priority_secondary),
         track_freeradius        = COALESCE($10, track_freeradius),
         track_classguard_api    = COALESCE($11, track_classguard_api),
         updated_at              = NOW()
       RETURNING *`,
      [vip_address, vip_prefix_len, vip_interface, vrrp_instance_name,
       vrrp_virtual_router_id, vrrp_auth_password, vrrp_advert_int,
       priority_primary, priority_secondary, track_freeradius ?? null,
       track_classguard_api ?? null]
    );
    res.json(keepalived.redactHaConfig(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/ha/vrrp/bundle — keepalived.conf (primary + secondary) + notify.sh
router.get('/vrrp/bundle', ...superauth, async (req, res) => {
  try {
    const bundle = await keepalived.buildVrrpOnlyBundle();
    res.json(bundle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.startHeartbeat = startHeartbeat;
