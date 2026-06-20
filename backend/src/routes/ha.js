const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const crypto   = require('crypto');
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const config     = require('../config');
const keepalived = require('../services/keepalived');

const auth      = [authenticate, requireMinRole('admin')];
const superauth = [authenticate, requireMinRole('superadmin')];

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

  // ON CONFLICT on hostname (existing unique constraint) — also stamps node_id
  await pool.query(
    `INSERT INTO nodes (node_id, hostname, ip, role, ha_role, api_url, version, last_seen, is_active)
     VALUES ($1, $2, '0.0.0.0', $3, $4, $5, $6, NOW(), true)
     ON CONFLICT (hostname) DO UPDATE SET
       node_id   = EXCLUDED.node_id,
       ha_role   = EXCLUDED.ha_role,
       api_url   = EXCLUDED.api_url,
       version   = EXCLUDED.version,
       last_seen = NOW(),
       is_active = true`,
    [nodeId, hostname, config.node.role, haRole, apiUrl, version]
  ).catch(err => console.warn('[ha] self-register:', err.message));
}

function startHeartbeat() {
  registerSelf();
  setInterval(async () => {
    const { rows: [{ in_recovery }] } = await pool.query('SELECT pg_is_in_recovery() AS in_recovery')
      .catch(() => ({ rows: [{ in_recovery: false }] }));

    if (in_recovery) {
      return relayToPrimary({ node_id: config.node.id, version: config.version });
    }

    await pool.query(
      `UPDATE nodes SET last_seen = NOW() WHERE node_id = $1`,
      [config.node.id]
    ).catch(() => {});
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

// DELETE /api/v1/ha/nodes/:nodeId
router.delete('/nodes/:nodeId', ...auth, async (req, res) => {
  if (req.params.nodeId === config.node.id) {
    return res.status(400).json({ error: 'Cannot remove the current node' });
  }
  try {
    const { rows } = await pool.query(
      'DELETE FROM nodes WHERE node_id = $1 RETURNING node_id', [req.params.nodeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
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

    const { rows: nodeRows } = await client.query(
      `INSERT INTO nodes (node_id, hostname, ip, role, ha_role, api_url, version, last_seen, is_active)
       VALUES ($1, $2, '0.0.0.0', 'secondary', $3, $4, $5, NOW(), true)
       ON CONFLICT (node_id) WHERE node_id IS NOT NULL DO UPDATE SET
         hostname  = EXCLUDED.hostname,
         ha_role   = EXCLUDED.ha_role,
         api_url   = EXCLUDED.api_url,
         version   = EXCLUDED.version,
         last_seen = NOW(),
         is_active = true
       RETURNING *`,
      [node_id, hostname || node_id, ha_role || invite.ha_role, api_url, version || 'unknown']
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
    }

    await client.query('COMMIT');
    res.status(201).json({ joined: true, node: nodeRows[0], replication });
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
    const { data } = await axios.post(`${cleanUrl}/api/v1/ha/join`, {
      token,
      node_id:  config.node.id,
      hostname: config.node.id,
      api_url:  config.appUrl,
      version:  config.version,
      request_replica: !!request_replica,
    }, { timeout: 8000 });

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
    if (data?.replication) {
      const { host, port, user, password, slot, appDbPassword } = data.replication;
      const lines = [
        'cd /opt/classguard',
        'docker compose down',
        'docker volume rm classguard_postgres-data',
        'docker volume create classguard_postgres-data',
        'docker run --rm \\',
        '  -v classguard_postgres-data:/var/lib/postgresql/data \\',
        `  -e PGPASSWORD='${password}' \\`,
        '  timescale/timescaledb:latest-pg15 \\',
        `  pg_basebackup -h ${host} -p ${port} -U ${user} -D /var/lib/postgresql/data -Fp -Xs -P -R${slot ? ` -S ${slot}` : ''}`,
      ];
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
      } else {
        lines.push('docker compose up -d postgres');
      }
      setupScript = lines.join('\n');
    }

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

router.get('/check-update', ...auth, async (req, res) => {
  try {
    const { data: latestVersionRaw } = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/VERSION?ref=main`,
      { headers: { Accept: 'application/vnd.github.raw' }, timeout: 8000 }
    );
    const latestVersion = String(latestVersionRaw).trim();

    let changelog = null;
    try {
      const { data: changelogRaw } = await axios.get(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/CHANGELOG.md?ref=main`,
        { headers: { Accept: 'application/vnd.github.raw' }, timeout: 8000 }
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
    res.status(502).json({ error: `Failed to check GitHub: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/ha/schedule-update — runs ON the primary. Writes one
// update_schedule row per active node directly (this table only exists on
// the primary's writable DB) — no relay needed on this side, since each
// secondary picks its own row up later via GET /update-status.
// ---------------------------------------------------------------------------
router.post('/schedule-update', ...superauth, async (req, res) => {
  const { scheduled_at, target_version } = req.body;
  if (!scheduled_at || !target_version) {
    return res.status(400).json({ error: 'scheduled_at and target_version are required' });
  }
  try {
    const { rows: nodeRows } = await pool.query(`SELECT node_id FROM nodes WHERE is_active = true`);
    const results = [];
    for (const { node_id } of nodeRows) {
      const { rows } = await pool.query(
        `INSERT INTO update_schedule (node_id, target_version, scheduled_at, requested_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (node_id) WHERE status IN ('pending', 'in_progress')
         DO UPDATE SET scheduled_at = EXCLUDED.scheduled_at, target_version = EXCLUDED.target_version
         RETURNING *`,
        [node_id, target_version, scheduled_at, req.user.userId || null]
      );
      results.push(rows[0]);
    }
    res.status(201).json({ scheduled: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/ha/schedule-update/:nodeId — cancel a pending/in_progress schedule for one node
router.delete('/schedule-update/:nodeId', ...superauth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE update_schedule SET status = 'failed', log = 'Cancelled by admin', completed_at = NOW()
       WHERE node_id = $1 AND status IN ('pending', 'in_progress') RETURNING id`,
      [req.params.nodeId]
    );
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

    const { rows: [primary] } = await pool.query(
      `SELECT api_url FROM nodes WHERE ha_role = 'primary' AND is_active ORDER BY last_seen DESC LIMIT 1`
    );
    const { rows: [secretRow] } = await pool.query(`SELECT value FROM settings WHERE key = 'internal_secret'`);
    if (!primary?.api_url || !secretRow?.value) {
      return res.json({ pending: null });
    }
    const { data } = await axios.get(`${primary.api_url}/api/v1/ha/update-status-for/${nodeId}`, {
      headers: { 'x-internal-secret': secretRow.value },
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

    const { rows: [primary] } = await pool.query(
      `SELECT api_url FROM nodes WHERE ha_role = 'primary' AND is_active ORDER BY last_seen DESC LIMIT 1`
    );
    const { rows: [secretRow] } = await pool.query(`SELECT value FROM settings WHERE key = 'internal_secret'`);
    if (!primary?.api_url || !secretRow?.value) {
      return res.status(503).json({ error: 'primary/secret not found in replicated data yet' });
    }
    await axios.post(`${primary.api_url}/api/v1/ha/update-complete-for/${nodeId}`, { status, log }, {
      headers: { 'x-internal-secret': secretRow.value },
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
    res.json(cfg);
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
    res.json(rows[0]);
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
