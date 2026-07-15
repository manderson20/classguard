const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const { pool } = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermission } = require('../middleware/permissions');
const radiusLdap = require('../services/radiusLdap');
const radiusSync = require('../services/radiusSync');
const keepalived = require('../services/keepalived');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 } });
const CERT_DIR = process.env.TLS_CERT_DIR || '/app/certs';

const auth      = [authenticate, requirePermission('radius')];
const superauth = [authenticate, requireMinRole('superadmin')];

// Internal-secret middleware for FreeRADIUS rlm_rest calls
function radiusSecret(req, res, next) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) return next(); // not configured → allow (dev mode)
  if (req.headers['x-internal-secret'] === secret) return next();
  // Also allow requests from localhost without secret (useful in testing)
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMac(raw) {
  if (!raw) return null;
  return raw.replace(/[^a-fA-F0-9]/g, '').match(/.{2}/g)?.join(':').toUpperCase() || null;
}

function isMacAddress(str) {
  return /^([0-9a-fA-F]{2}[:\-. ]?){5}[0-9a-fA-F]{2}$/.test((str || '').trim());
}

// RADIUS attribute helper — returns FreeRADIUS REST response format
function radiusAccept(vlan, sessionTimeout = 28800) {
  const attrs = {
    'control:Auth-Type': { value: ['Accept'] },
    'reply:Session-Timeout': { value: [String(sessionTimeout)] },
  };
  if (vlan) {
    attrs['reply:Tunnel-Type']             = { value: ['VLAN'] };
    attrs['reply:Tunnel-Medium-Type']      = { value: ['IEEE-802'] };
    attrs['reply:Tunnel-Private-Group-Id'] = { value: [String(vlan)] };
  }
  return attrs;
}

function radiusReject(reason) {
  return {
    'control:Auth-Type':       { value: ['Reject'] },
    'reply:Reply-Message':     { value: [reason || 'Access denied'] },
  };
}

// Extract first value from FreeRADIUS rlm_rest attribute object
function attr(body, key) {
  return body?.[key]?.value?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// FreeRADIUS rlm_rest hooks
// ---------------------------------------------------------------------------

// Evaluate Wi-Fi policies for a user on an SSID → { allowed, reason?, vlan? }.
// Runs in BOTH /authorize and /authenticate: the EAP-TTLS/GTC flow (what a
// profile-less iPhone does) reaches /authenticate via the eap module without
// ever passing through /authorize's policy pass, so /authenticate cannot
// assume policies were already enforced.
async function evaluateUserPolicy(username, ssid) {
  // Domain-level policy first, independent of whether this email exists in
  // ClassGuard's own `users` table at all — a district that hasn't (or never
  // will) sync students into `users` still needs a real "deny
  // students.<domain>" decision, not an accidental pass because the
  // deny-by-domain rule could never run for an unsynced user.
  const domain = username.includes('@') ? username.split('@').pop().toLowerCase() : null;
  if (domain) {
    const { rows: domainRows } = await pool.query(
      `SELECT can_access FROM radius_user_policies
       WHERE email_domain = $1 AND (ssid IS NULL OR ssid = $2)
       ORDER BY priority DESC NULLS LAST LIMIT 1`,
      [domain, ssid || '']
    );
    if (domainRows.length && domainRows[0].can_access === false) {
      return { allowed: false, reason: 'domain policy denied' };
    }
  }

  const { rows } = await pool.query(
    `SELECT u.*, rp.vlan, rp.can_access
     FROM users u
     LEFT JOIN radius_user_policies rp ON (
       rp.user_id = u.id
       OR rp.group_id IN (SELECT group_id FROM group_members WHERE user_id = u.id)
       OR (rp.google_ou IS NOT NULL AND u.google_ou IS NOT NULL
           AND (u.google_ou = rp.google_ou OR u.google_ou LIKE rp.google_ou || '/%'))
       OR (rp.email_domain IS NOT NULL AND rp.email_domain = lower(split_part(u.email, '@', 2)))
       OR (rp.user_id IS NULL AND rp.group_id IS NULL AND rp.google_ou IS NULL AND rp.email_domain IS NULL) -- default/catch-all policy
     ) AND (rp.ssid IS NULL OR rp.ssid = $2)
     WHERE lower(u.email) = lower($1) AND u.is_active = true
     ORDER BY (rp.user_id IS NOT NULL) DESC, (rp.group_id IS NOT NULL) DESC,
              (rp.google_ou IS NOT NULL) DESC, length(rp.google_ou) DESC NULLS LAST,
              (rp.email_domain IS NOT NULL) DESC, rp.priority DESC NULLS LAST
     LIMIT 1`,
    [username, ssid || '']
  );

  if (!rows.length) return { allowed: false, reason: 'user not found or inactive' };
  if (rows[0].can_access === false) return { allowed: false, reason: 'user policy denied' };
  return { allowed: true, vlan: rows[0].vlan || null };
}

// POST /api/v1/radius/authorize
// Called for every auth request. Handles both MAB and EAP-TTLS user auth.
router.post('/authorize', radiusSecret, async (req, res) => {
  try {
    const username    = attr(req.body, 'User-Name');
    const callingId   = attr(req.body, 'Calling-Station-Id'); // MAC in MAB
    const nasIp       = attr(req.body, 'NAS-IP-Address');
    const calledId    = attr(req.body, 'Called-Station-Id');  // AP-MAC:SSID
    const ssid        = calledId?.split(':').pop() || null;

    const isMab = isMacAddress(username);
    const mac   = isMab ? parseMac(username) : parseMac(callingId);

    // -- MAB: device-based auth --
    if (isMab && mac) {
      const { rows } = await pool.query(
        'SELECT * FROM radius_devices WHERE mac_address = $1', [mac]
      );

      let result, vlan, rejectReason;

      if (!rows.length) {
        // First time we've seen this device — add as pending
        await pool.query(
          `INSERT INTO radius_devices (mac_address, source, status, last_seen, last_auth_at, last_auth_result)
           VALUES ($1, 'radius_seen', 'pending', NOW(), NOW(), 'rejected')
           ON CONFLICT (mac_address) DO UPDATE SET
             last_seen = NOW(), last_auth_at = NOW(), last_auth_result = 'rejected'`,
          [mac]
        );
        result = 'rejected';
        rejectReason = 'unknown device — pending admin review';
      } else {
        const device = rows[0];
        if (device.status === 'blocked') {
          result = 'rejected';
          rejectReason = 'device is blocked';
        } else if (device.status === 'approved') {
          result = 'accepted';
          vlan   = device.assigned_vlan;
        } else {
          result = 'rejected';
          rejectReason = 'device pending approval';
        }

        await pool.query(
          `UPDATE radius_devices SET last_seen = NOW(), last_auth_at = NOW(),
             last_auth_result = $1 WHERE mac_address = $2`,
          [result, mac]
        );
      }

      // A device without its own VLAN falls back to the NAS's default_vlan
      // (set per-AP/switch in the NAS Clients tab). Lets a district pin a
      // building's corporate VLAN on that building's NAS entries so devices
      // "float" — same SSID, different VLAN/subnet per building. When neither
      // is set, no Tunnel-* attrs are returned and the client stays on the
      // WLAN's own network, which on a per-building WLAN achieves the same.
      if (result === 'accepted' && !vlan && nasIp) {
        const { rows: [nasRow] } = await pool.query(
          `SELECT default_vlan FROM radius_nas WHERE ip_address = $1::inet AND is_active = true`,
          [nasIp]
        ).catch(() => ({ rows: [] }));
        vlan = nasRow?.default_vlan || null;
      }

      // Log it
      await pool.query(
        `INSERT INTO radius_auth_log
           (username, mac_address, nas_ip, ssid, result, reject_reason, auth_type, vlan_assigned)
         VALUES ($1,$2,$3,$4,$5,$6,'mab',$7)`,
        [mac, mac, nasIp, ssid, result, rejectReason || null, vlan || null]
      );

      return res.json(result === 'accepted' ? radiusAccept(vlan) : radiusReject(rejectReason));
    }

    // -- EAP user auth: look up user, set Auth-Type so FreeRADIUS calls /authenticate --
    if (username && !isMab) {
      const logReject = (reason) => pool.query(
        `INSERT INTO radius_auth_log
           (username, mac_address, nas_ip, ssid, result, reject_reason, auth_type)
         VALUES ($1,$2,$3,$4,'rejected',$5,'eap-ttls')`,
        [username, parseMac(callingId), nasIp, ssid, reason]
      ).catch(() => {}); // logging failure shouldn't block the reject response

      const policy = await evaluateUserPolicy(username, ssid);
      if (!policy.allowed) {
        await logReject(policy.reason);
        return res.json(radiusReject(policy.reason));
      }

      // Tell FreeRADIUS to use our REST authenticate endpoint
      return res.json({
        'control:Auth-Type': { value: ['rest'] },
        'control:ClassGuard-VLAN': { value: [String(policy.vlan || '')] },
      });
    }

    return res.json(radiusReject('could not determine auth type'));
  } catch (err) {
    console.error('[radius/authorize]', err.message);
    res.status(500).json(radiusReject('internal error'));
  }
});

// POST /api/v1/radius/authenticate
// Called for EAP-TTLS/PAP — receives cleartext password inside TLS tunnel.
router.post('/authenticate', radiusSecret, async (req, res) => {
  try {
    const username = attr(req.body, 'User-Name');
    const password = attr(req.body, 'User-Password');
    const nasIp    = attr(req.body, 'NAS-IP-Address');
    const calledId = attr(req.body, 'Called-Station-Id');
    const ssid     = calledId?.split(':').pop() || null;
    const mac      = parseMac(attr(req.body, 'Calling-Station-Id'));
    const vlanHint = attr(req.body, 'control:ClassGuard-VLAN');

    // Policy check must happen HERE, not just in /authorize: the TTLS/GTC
    // flow (profile-less iPhones) arrives via the inner-tunnel eap module,
    // which never runs the REST /authorize policy pass. For the TTLS/PAP
    // flow this repeats /authorize's verdict — same answer, no harm.
    const policy = await evaluateUserPolicy(username || '', ssid);
    const result = policy.allowed
      ? await radiusLdap.authenticateUser(username, password)
      : { ok: false, reason: policy.reason };
    const vlan = result.ok ? (policy.vlan ?? vlanHint ?? null) : null;

    await pool.query(
      `INSERT INTO radius_auth_log
         (username, mac_address, nas_ip, ssid, result, reject_reason, auth_type, vlan_assigned)
       VALUES ($1,$2,$3,$4,$5,$6,'eap-ttls',$7)`,
      [username, mac, nasIp, ssid,
       result.ok ? 'accepted' : 'rejected',
       result.ok ? null : result.reason,
       vlan]
    );

    if (result.ok) {
      return res.json(radiusAccept(vlan));
    } else {
      return res.json(radiusReject(result.reason));
    }
  } catch (err) {
    console.error('[radius/authenticate]', err.message);
    res.status(500).json(radiusReject('internal error'));
  }
});

// POST /api/v1/radius/accounting
// Session tracking — Start, Alive (Interim-Update), Stop.
router.post('/accounting', radiusSecret, async (req, res) => {
  try {
    const statusType = attr(req.body, 'Acct-Status-Type'); // Start, Stop, Interim-Update
    const sessionId  = attr(req.body, 'Acct-Session-Id');
    const username   = attr(req.body, 'User-Name');
    const mac        = parseMac(attr(req.body, 'Calling-Station-Id'));
    const nasIp      = attr(req.body, 'NAS-IP-Address');
    const nasId      = attr(req.body, 'NAS-Identifier');
    const calledId   = attr(req.body, 'Called-Station-Id');
    const ssid       = calledId?.split(':').pop() || null;
    const apMac      = calledId?.split(':').slice(0, 6).join(':') || null;
    const framedIp   = attr(req.body, 'Framed-IP-Address');
    const bytesIn    = parseInt(attr(req.body, 'Acct-Input-Octets')  || '0');
    const bytesOut   = parseInt(attr(req.body, 'Acct-Output-Octets') || '0');

    if (!sessionId) return res.json({ success: true });

    if (statusType === 'Start') {
      await pool.query(
        `INSERT INTO radius_sessions
           (acct_session_id, username, mac_address, ip_address, nas_ip, nas_id,
            ssid, ap_mac, bytes_in, bytes_out, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
         ON CONFLICT (acct_session_id) DO UPDATE SET
           last_update = NOW(), is_active = true`,
        [sessionId, username, mac, framedIp, nasIp, nasId, ssid, apMac, bytesIn, bytesOut]
      );
    } else if (statusType === 'Interim-Update') {
      await pool.query(
        `UPDATE radius_sessions SET last_update = NOW(), bytes_in = $2, bytes_out = $3,
           ip_address = COALESCE($4, ip_address)
         WHERE acct_session_id = $1`,
        [sessionId, bytesIn, bytesOut, framedIp]
      );
    } else if (statusType === 'Stop') {
      await pool.query(
        `UPDATE radius_sessions SET is_active = false, last_update = NOW(),
           bytes_in = $2, bytes_out = $3
         WHERE acct_session_id = $1`,
        [sessionId, bytesIn, bytesOut]
      );
    }

    // Update device last_seen
    if (mac) {
      await pool.query(
        'UPDATE radius_devices SET last_seen = NOW() WHERE mac_address = $1', [mac]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[radius/accounting]', err.message);
    res.status(500).json({ success: false });
  }
});

// ---------------------------------------------------------------------------
// NAS clients CRUD
// ---------------------------------------------------------------------------

router.get('/nas', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id,name,shortname,ip_address,vendor,description,default_vlan,is_active,created_at FROM radius_nas ORDER BY name'
  );
  // Never return shared_secret in list
  res.json(rows);
});

router.post('/nas', ...auth, async (req, res) => {
  const { name, shortname, ip_address, shared_secret, vendor, description, default_vlan } = req.body;
  if (!name || !ip_address || !shared_secret) {
    return res.status(400).json({ error: 'name, ip_address, shared_secret required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO radius_nas (name, shortname, ip_address, shared_secret, vendor, description, default_vlan)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, shortname, ip_address, vendor, is_active`,
      [name, shortname || name, ip_address, shared_secret,
       vendor || 'other', description || null, default_vlan || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/nas/:id', ...auth, async (req, res) => {
  const { name, shortname, ip_address, shared_secret, vendor, description, default_vlan, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE radius_nas SET
         name          = COALESCE($1, name),
         shortname     = COALESCE($2, shortname),
         ip_address    = COALESCE($3::inet, ip_address),
         shared_secret = CASE WHEN $4 IS NOT NULL AND $4 <> '' THEN $4 ELSE shared_secret END,
         vendor        = COALESCE($5, vendor),
         description   = COALESCE($6, description),
         default_vlan  = COALESCE($7, default_vlan),
         is_active     = COALESCE($8, is_active),
         updated_at    = NOW()
       WHERE id = $9
       RETURNING id, name, shortname, ip_address, vendor, is_active`,
      [name, shortname, ip_address, shared_secret || null, vendor, description,
       default_vlan || null, is_active ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/nas/:id', ...superauth, async (req, res) => {
  await pool.query('DELETE FROM radius_nas WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// UniFi setup — wire ClassGuard into the controller as its RADIUS server
// straight from the UI: create/refresh a "ClassGuard" RADIUS profile, then
// flip individual WLANs to 802.1X (BYOD) or PSK+MAC-auth (corporate NAC).
// Every change is an explicit admin action against a named WLAN — nothing
// here runs automatically.
// ---------------------------------------------------------------------------

const CG_PROFILE_NAME = 'ClassGuard';
// UniFi's WLAN "MAC Address Format" values. ClassGuard's own parser accepts
// every one of them (parseMac strips separators), so the choice only matters
// for readability in external logs.
const MAC_FORMATS = ['none_lower', 'hyphen_lower', 'colon_lower', 'none_upper', 'hyphen_upper', 'colon_upper'];

async function getUnifiController() {
  const { rows: [ctrl] } = await pool.query(
    `SELECT * FROM network_controllers WHERE vendor = 'unifi' AND is_active = true ORDER BY created_at LIMIT 1`
  );
  return ctrl || null;
}

async function getRadiusServerConfig() {
  const [{ rows: [ha] }, { rows: [secretRow] }] = await Promise.all([
    pool.query(`SELECT vip_address FROM radius_ha_config LIMIT 1`),
    pool.query(`SELECT value FROM settings WHERE key = 'radius_default_nas_secret'`),
  ]);
  return { serverIp: ha?.vip_address || null, secret: secretRow?.value || null };
}

// GET /radius/unifi/setup — controller + profiles + WLANs in one shot
router.get('/unifi/setup', ...auth, async (req, res) => {
  try {
    const ctrl = await getUnifiController();
    if (!ctrl) return res.json({ configured: false });

    const unifi = require('../services/network/unifi');
    const [{ serverIp, secret }, profiles, wlans] = await Promise.all([
      getRadiusServerConfig(),
      unifi.fetchRadiusProfiles(ctrl),
      unifi.fetchWlans(ctrl),
    ]);

    const cgProfile = profiles.find(p => p.name === CG_PROFILE_NAME) || null;
    res.json({
      configured: true,
      controller: { id: ctrl.id, name: ctrl.name, base_url: ctrl.base_url, site_id: ctrl.site_id },
      radius_server: { ip: serverIp, secret_set: !!secret },
      classguard_profile: cgProfile && {
        _id: cgProfile._id,
        auth_servers: (cgProfile.auth_servers || []).map(s => ({ ip: s.ip, port: s.port })),
        acct_servers: (cgProfile.acct_servers || []).map(s => ({ ip: s.ip, port: s.port })),
        accounting_enabled: !!cgProfile.accounting_enabled,
        vlan_enabled: !!cgProfile.vlan_enabled,
        vlan_wlan_mode: cgProfile.vlan_wlan_mode || 'disabled',
      },
      other_profiles: profiles.filter(p => p.name !== CG_PROFILE_NAME).map(p => ({ _id: p._id, name: p.name })),
      wlans: wlans.map(w => ({
        _id: w._id, name: w.name, enabled: w.enabled, security: w.security,
        macauth_enabled: !!w.macauth_enabled,
        radius_mac_auth_format: w.radius_mac_auth_format || 'none_lower',
        radiusprofile_id: w.radiusprofile_id || null,
        uses_classguard: !!cgProfile && w.radiusprofile_id === cgProfile._id,
        networkconf_id: w.networkconf_id || null,
      })),
      mac_formats: MAC_FORMATS,
    });
  } catch (err) {
    console.error('[radius/unifi/setup]', err.message);
    res.status(502).json({ error: `UniFi controller: ${err.message}` });
  }
});

// POST /radius/unifi/profile — create or refresh the ClassGuard RADIUS profile
router.post('/unifi/profile', ...auth, async (req, res) => {
  try {
    const ctrl = await getUnifiController();
    if (!ctrl) return res.status(400).json({ error: 'No active UniFi controller configured (Integrations → Network)' });

    const { serverIp, secret } = await getRadiusServerConfig();
    if (!serverIp) return res.status(400).json({ error: 'RADIUS virtual IP not configured (HA & Config tab)' });
    if (!secret)   return res.status(400).json({ error: 'radius_default_nas_secret not set (HA & Config tab)' });

    const desired = {
      name: CG_PROFILE_NAME,
      auth_servers: [{ ip: serverIp, port: 1812, x_secret: secret }],
      acct_servers: [{ ip: serverIp, port: 1813, x_secret: secret }],
      accounting_enabled: true,
      interim_update_enabled: true,
      interim_update_interval: 3600,
      // "optional" = APs honor Tunnel-Private-Group-Id when ClassGuard sends
      // one (BYOD policies) and keep the WLAN's own network when it doesn't
      // (corporate MAB) — exactly the split-VLAN behavior we document in the UI.
      vlan_enabled: true,
      vlan_wlan_mode: 'optional',
      use_usg_auth_server: false,
    };

    const unifi   = require('../services/network/unifi');
    const existing = (await unifi.fetchRadiusProfiles(ctrl)).find(p => p.name === CG_PROFILE_NAME);
    const profile  = existing
      ? await unifi.updateRadiusProfile(ctrl, existing._id, desired)
      : await unifi.createRadiusProfile(ctrl, desired);
    res.json({ ok: true, created: !existing, profile_id: profile?._id || existing?._id });
  } catch (err) {
    console.error('[radius/unifi/profile]', err.message);
    res.status(502).json({ error: `UniFi controller: ${err.message}` });
  }
});

// PUT /radius/unifi/wlans/:id — apply a RADIUS role to one WLAN
router.put('/unifi/wlans/:id', ...auth, async (req, res) => {
  try {
    const { action, mac_format } = req.body;
    const ctrl = await getUnifiController();
    if (!ctrl) return res.status(400).json({ error: 'No active UniFi controller configured' });
    if (mac_format && !MAC_FORMATS.includes(mac_format)) {
      return res.status(400).json({ error: `mac_format must be one of ${MAC_FORMATS.join(', ')}` });
    }

    const unifi = require('../services/network/unifi');
    const cgProfile = (await unifi.fetchRadiusProfiles(ctrl)).find(p => p.name === CG_PROFILE_NAME);
    if (!cgProfile && action !== 'disable_macauth') {
      return res.status(400).json({ error: 'Create the ClassGuard RADIUS profile first' });
    }

    let patch;
    if (action === 'enable_byod') {
      // WPA-Enterprise: users sign in with Google credentials via EAP-TTLS
      patch = { security: 'wpaeap', radiusprofile_id: cgProfile._id };
    } else if (action === 'enable_macauth') {
      // Keeps the WLAN's existing security (PSK) and adds RADIUS MAC auth on top
      patch = { macauth_enabled: true, radiusprofile_id: cgProfile._id, radius_mac_auth_format: mac_format || 'none_lower' };
    } else if (action === 'disable_macauth') {
      patch = { macauth_enabled: false };
    } else if (action === 'set_mac_format') {
      patch = { radius_mac_auth_format: mac_format || 'none_lower' };
    } else {
      return res.status(400).json({ error: 'action must be enable_byod, enable_macauth, disable_macauth or set_mac_format' });
    }

    const wlan = await unifi.updateWlan(ctrl, req.params.id, patch);
    res.json({ ok: true, wlan: wlan && { _id: wlan._id, name: wlan.name, security: wlan.security, macauth_enabled: !!wlan.macauth_enabled } });
  } catch (err) {
    console.error('[radius/unifi/wlan]', err.message);
    res.status(502).json({ error: `UniFi controller: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Device NAC — list, update status, bulk actions
// ---------------------------------------------------------------------------

router.get('/devices', ...auth, async (req, res) => {
  const { status, source, device_type, search, limit = 100, offset = 0 } = req.query;
  const conditions = [];
  const params     = [];

  if (status) { conditions.push(`d.status = $${params.length+1}`); params.push(status); }
  if (source) { conditions.push(`d.source = $${params.length+1}`); params.push(source); }
  if (device_type) { conditions.push(`d.device_type = $${params.length+1}`); params.push(device_type); }
  if (search) {
    conditions.push(`(d.mac_address::text ILIKE $${params.length+1} OR d.device_name ILIKE $${params.length+1})`);
    params.push(`%${search}%`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT d.*,
            u.full_name AS assigned_user_name, u.email AS assigned_user_email,
            COALESCE(
              json_agg(
                json_build_object(
                  'source',           s.source,
                  'source_device_id', s.source_device_id,
                  'source_name',      s.source_name,
                  'source_extra',     s.source_extra,
                  'is_active',        s.is_active,
                  'last_synced_at',   s.last_synced_at,
                  'removed_at',       s.removed_at
                ) ORDER BY s.is_active DESC, s.source
              ) FILTER (WHERE s.id IS NOT NULL),
              '[]'
            ) AS sources
     FROM radius_devices d
     LEFT JOIN users u ON u.id = d.assigned_user_id
     LEFT JOIN radius_device_sources s ON s.device_id = d.id
     ${where}
     GROUP BY d.id, u.full_name, u.email
     ORDER BY
       CASE d.status WHEN 'pending' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,
       d.updated_at DESC
     LIMIT $${params.length+1} OFFSET $${params.length+2}`,
    [...params, limit, offset]
  );

  const { rows: counts } = await pool.query(
    `SELECT status, COUNT(*) FROM radius_devices GROUP BY status`
  );

  res.json({
    devices: rows,
    counts:  Object.fromEntries(counts.map(r => [r.status, parseInt(r.count)])),
    total:   parseInt((await pool.query(`SELECT COUNT(*) FROM radius_devices ${where}`, params)).rows[0].count),
  });
});

router.put('/devices/:id', ...auth, async (req, res) => {
  const { status, device_name, device_type, assigned_user_id, assigned_vlan, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE radius_devices SET
         status           = COALESCE($1, status),
         device_name      = COALESCE($2, device_name),
         device_type      = COALESCE($3, device_type),
         assigned_user_id = COALESCE($4::uuid, assigned_user_id),
         assigned_vlan    = COALESCE($5, assigned_vlan),
         notes            = COALESCE($6, notes),
         updated_at       = NOW()
       WHERE id = $7 RETURNING *`,
      [status, device_name, device_type,
       assigned_user_id || null, assigned_vlan || null, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /devices/bulk — bulk approve or block a specific set of ids
router.post('/devices/bulk', ...auth, async (req, res) => {
  const { ids, status } = req.body;
  if (!ids?.length || !['approved','blocked','pending'].includes(status)) {
    return res.status(400).json({ error: 'ids[] and valid status required' });
  }
  await pool.query(
    'UPDATE radius_devices SET status = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])',
    [status, ids]
  );
  res.json({ updated: ids.length });
});

// POST /devices/bulk-by-filter — bulk approve/block every device matching a
// filter (status/source/device_type/search), not just what's loaded on the
// current page. Needed for categories with thousands of devices (e.g. 2000+
// Chromebooks) where selecting rows one page at a time isn't practical.
router.post('/devices/bulk-by-filter', ...auth, async (req, res) => {
  const { status, source, device_type, search, newStatus } = req.body;
  if (!['approved','blocked','pending'].includes(newStatus)) {
    return res.status(400).json({ error: 'valid newStatus required' });
  }

  const conditions = [];
  const params     = [];
  if (status)      { conditions.push(`status = $${params.length+1}`);      params.push(status); }
  if (source)       { conditions.push(`source = $${params.length+1}`);      params.push(source); }
  if (device_type)  { conditions.push(`device_type = $${params.length+1}`); params.push(device_type); }
  if (search) {
    conditions.push(`(mac_address::text ILIKE $${params.length+1} OR device_name ILIKE $${params.length+1})`);
    params.push(`%${search}%`);
  }
  // Require at least one filter — an unfiltered call would silently touch
  // every device in the table, which is never the intent of a "by category" action.
  if (!conditions.length) {
    return res.status(400).json({ error: 'at least one filter (status/source/device_type/search) is required' });
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  const { rows } = await pool.query(
    `UPDATE radius_devices SET status = $${params.length+1}, updated_at = NOW() ${where} RETURNING id`,
    [...params, newStatus]
  );
  res.json({ updated: rows.length });
});

router.delete('/devices/:id', ...superauth, async (req, res) => {
  await pool.query('DELETE FROM radius_devices WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

// POST /devices/add — manually add a MAC
router.post('/devices', ...auth, async (req, res) => {
  const { mac_address, device_name, device_type, status, assigned_vlan, notes } = req.body;
  const mac = radiusSync.normaliseMac(mac_address);
  if (!mac) return res.status(400).json({ error: 'invalid MAC address' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO radius_devices (mac_address, device_name, device_type, status, assigned_vlan, notes, source, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,'manual',$7)
       ON CONFLICT (mac_address) DO UPDATE SET
         device_name   = COALESCE(EXCLUDED.device_name, radius_devices.device_name),
         status        = EXCLUDED.status,
         assigned_vlan = COALESCE(EXCLUDED.assigned_vlan, radius_devices.assigned_vlan),
         notes         = COALESCE(EXCLUDED.notes, radius_devices.notes),
         updated_at    = NOW()
       RETURNING *`,
      [mac, device_name || null, device_type || 'other',
       status || 'approved', assigned_vlan || null, notes || null, req.user?.id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Device sync from MDM sources
// ---------------------------------------------------------------------------

router.post('/sync-devices', ...auth, async (req, res) => {
  res.json({ status: 'started' });
  radiusSync.syncAllSources(msg => console.log('[radius/sync]', msg))
    .catch(err => console.error('[radius/sync]', err.message));
});

// ---------------------------------------------------------------------------
// User WiFi policies
// ---------------------------------------------------------------------------

router.get('/policies', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, u.full_name, u.email, g.name AS group_name
     FROM radius_user_policies p
     LEFT JOIN users  u ON u.id = p.user_id
     LEFT JOIN groups g ON g.id = p.group_id
     ORDER BY p.priority DESC, p.id`
  );
  res.json(rows);
});

// Same data as /api/v1/policies/ou-list, but reachable with the `radius`
// permission — a RADIUS admin isn't guaranteed the `policies` permission.
router.get('/ou-list', ...auth, async (req, res) => {
  const [fromSettings, fromUsers] = await Promise.all([
    pool.query(`SELECT value FROM settings WHERE key = 'google_ous'`),
    pool.query(`SELECT DISTINCT google_ou AS path FROM users
                WHERE google_ou IS NOT NULL AND google_ou <> ''`),
  ]);
  let fromTree = [];
  try {
    fromTree = (JSON.parse(fromSettings.rows[0]?.value || '[]')).map(ou => ou.path).filter(Boolean);
  } catch { /* google_ous not set or not valid JSON yet — fall back to synced users */ }
  res.json([...new Set([...fromTree, ...fromUsers.rows.map(r => r.path)])].sort());
});

router.post('/policies', ...auth, async (req, res) => {
  const { user_id, group_id, google_ou, email_domain, ssid, vlan, can_access, priority, notes } = req.body;
  // A policy with none of user_id/group_id/google_ou/email_domain is a
  // default/catch-all that applies to anyone authenticating — require an
  // SSID so it can't accidentally apply org-wide across every network by
  // omission. OU and domain rules need an SSID for the same reason: they
  // can otherwise match a whole population across every network on the
  // cluster.
  if (!user_id && !group_id && !google_ou && !email_domain && !ssid) {
    return res.status(400).json({ error: 'user_id, group_id, google_ou, email_domain, or (for a default policy) ssid is required' });
  }
  if (email_domain && !ssid) {
    return res.status(400).json({ error: 'ssid is required for a domain-based policy' });
  }
  if (google_ou && !ssid) {
    return res.status(400).json({ error: 'ssid is required for an OU-based policy' });
  }
  if (google_ou && !google_ou.startsWith('/')) {
    return res.status(400).json({ error: 'google_ou must be a full OU path starting with / (e.g. /Students/High School)' });
  }
  const { rows } = await pool.query(
    `INSERT INTO radius_user_policies (user_id, group_id, google_ou, email_domain, ssid, vlan, can_access, priority, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [user_id || null, group_id || null, google_ou ? google_ou.replace(/\/+$/, '') || '/' : null,
     email_domain ? email_domain.toLowerCase() : null, ssid || null,
     vlan || null, can_access ?? true, priority || 0, notes || null]
  );
  res.status(201).json(rows[0]);
});

// Fields present in the body are set (including to null/blank to clear them);
// absent fields are left untouched. The merged result must satisfy the same
// invariants as POST — otherwise an edit could turn an SSID-scoped rule into
// an accidental org-wide catch-all.
router.put('/policies/:id', ...auth, async (req, res) => {
  const { rows: existing } = await pool.query(
    'SELECT * FROM radius_user_policies WHERE id = $1', [req.params.id]
  );
  if (!existing.length) return res.status(404).json({ error: 'not found' });
  const cur = existing[0];
  const has = k => Object.prototype.hasOwnProperty.call(req.body, k);

  const next = {
    user_id:      has('user_id')      ? req.body.user_id  || null : cur.user_id,
    group_id:     has('group_id')     ? req.body.group_id || null : cur.group_id,
    google_ou:    has('google_ou')    ? (req.body.google_ou ? req.body.google_ou.replace(/\/+$/, '') || '/' : null) : cur.google_ou,
    email_domain: has('email_domain') ? (req.body.email_domain ? req.body.email_domain.toLowerCase() : null) : cur.email_domain,
    ssid:         has('ssid')         ? req.body.ssid || null : cur.ssid,
    vlan:         has('vlan')         ? req.body.vlan || null : cur.vlan,
    can_access:   has('can_access')   ? (req.body.can_access ?? cur.can_access) : cur.can_access,
    priority:     has('priority')     ? (req.body.priority ?? 0) : cur.priority,
    notes:        has('notes')        ? req.body.notes || null : cur.notes,
  };

  if (!next.user_id && !next.group_id && !next.google_ou && !next.email_domain && !next.ssid) {
    return res.status(400).json({ error: 'user_id, group_id, google_ou, email_domain, or (for a default policy) ssid is required' });
  }
  if (next.email_domain && !next.ssid) {
    return res.status(400).json({ error: 'ssid is required for a domain-based policy' });
  }
  if (next.google_ou && !next.ssid) {
    return res.status(400).json({ error: 'ssid is required for an OU-based policy' });
  }
  if (next.google_ou && !next.google_ou.startsWith('/')) {
    return res.status(400).json({ error: 'google_ou must be a full OU path starting with / (e.g. /Students/High School)' });
  }

  const { rows } = await pool.query(
    `UPDATE radius_user_policies SET
       user_id = $1, group_id = $2, google_ou = $3, email_domain = $4,
       ssid = $5, vlan = $6, can_access = $7, priority = $8, notes = $9
     WHERE id = $10 RETURNING *`,
    [next.user_id, next.group_id, next.google_ou, next.email_domain,
     next.ssid, next.vlan, next.can_access, next.priority, next.notes, req.params.id]
  );
  res.json(rows[0]);
});

router.delete('/policies/:id', ...auth, async (req, res) => {
  await pool.query('DELETE FROM radius_user_policies WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Active sessions
// ---------------------------------------------------------------------------

router.get('/sessions', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, d.device_name, d.device_type, d.status AS device_status
     FROM radius_sessions s
     LEFT JOIN radius_devices d ON d.mac_address = s.mac_address
     WHERE s.is_active = true
     ORDER BY s.started_at DESC`
  );
  res.json(rows);
});

router.delete('/sessions/:id', ...auth, async (req, res) => {
  await pool.query(
    'UPDATE radius_sessions SET is_active = false WHERE id = $1', [req.params.id]
  );
  res.json({ disconnected: true });
});

// ---------------------------------------------------------------------------
// Auth log
// ---------------------------------------------------------------------------

router.get('/log', ...auth, async (req, res) => {
  const { result, limit = 200, offset = 0 } = req.query;
  const where  = result ? 'WHERE result = $3' : '';
  const params = result ? [limit, offset, result] : [limit, offset];
  const { rows } = await pool.query(
    `SELECT * FROM radius_auth_log ${where}
     ORDER BY logged_at DESC LIMIT $1 OFFSET $2`,
    params
  );
  res.json(rows);
});

router.get('/stats', ...auth, async (req, res) => {
  const [{ rows: today }, { rows: sessions }, { rows: pending }] = await Promise.all([
    pool.query(`SELECT result, COUNT(*) FROM radius_auth_log
                WHERE logged_at > NOW() - INTERVAL '24h' GROUP BY result`),
    pool.query('SELECT COUNT(*) FROM radius_sessions WHERE is_active = true'),
    pool.query("SELECT COUNT(*) FROM radius_devices WHERE status = 'pending'"),
  ]);
  res.json({
    accepted_24h:    parseInt(today.find(r=>r.result==='accepted')?.count || 0),
    rejected_24h:    parseInt(today.find(r=>r.result==='rejected')?.count || 0),
    active_sessions: parseInt(sessions[0].count),
    pending_devices: parseInt(pending[0].count),
  });
});

// ---------------------------------------------------------------------------
// HA / VRRP config
// ---------------------------------------------------------------------------

router.get('/ha', ...auth, async (req, res) => {
  const cfg = await keepalived.getHaConfig();
  res.json(keepalived.redactHaConfig(cfg));
});

router.put('/ha', ...superauth, async (req, res) => {
  const { vip_address, vip_prefix_len, vip_interface, vrrp_instance_name,
          vrrp_virtual_router_id, vrrp_auth_password, vrrp_advert_int,
          priority_primary, priority_secondary, track_freeradius } = req.body;
  const { rows } = await pool.query(
    `UPDATE radius_ha_config SET
       vip_address            = COALESCE($1::inet, vip_address),
       vip_prefix_len         = COALESCE($2, vip_prefix_len),
       vip_interface          = COALESCE($3, vip_interface),
       vrrp_instance_name     = COALESCE($4, vrrp_instance_name),
       vrrp_virtual_router_id = COALESCE($5, vrrp_virtual_router_id),
       vrrp_auth_password     = COALESCE($6, vrrp_auth_password),
       vrrp_advert_int        = COALESCE($7, vrrp_advert_int),
       priority_primary       = COALESCE($8, priority_primary),
       priority_secondary     = COALESCE($9, priority_secondary),
       track_freeradius       = COALESCE($10, track_freeradius),
       updated_at             = NOW()
     RETURNING *`,
    [vip_address, vip_prefix_len, vip_interface, vrrp_instance_name,
     vrrp_virtual_router_id, vrrp_auth_password, vrrp_advert_int,
     priority_primary, priority_secondary, track_freeradius ?? null]
  );
  res.json(keepalived.redactHaConfig(rows[0]));
});

// GET /radius/config-bundle — returns all FreeRADIUS + Keepalived config files
router.get('/config-bundle', ...superauth, async (req, res) => {
  try {
    const bundle = await keepalived.buildConfigBundle();
    res.json(bundle);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// GET /radius/freeradius-sync — localhost-only, no auth (same trust boundary
// as /ha/firewall-rules and /ha/vrrp-sync), polled every minute by
// infrastructure/freeradius/sync-freeradius.sh AND run once during
// install.sh. Self-scoped: unlike /config-bundle (which returns every node's
// keepalived files at once for manual download), this only returns the
// FreeRADIUS files themselves -- they're identical on every node (no
// per-node templating the way keepalived.conf has), so there's nothing to
// select by node_id here. Gated on track_freeradius -- the same flag
// /ha/firewall-rules and keepalived's own check_freeradius script use, so
// "FreeRADIUS should be running here" means the same thing everywhere.
// connect_uri is hardcoded to localhost rather than using APP_URL -- each
// node's FreeRADIUS should always talk to its OWN node-local API container,
// never hop through nginx/the VIP for this.
// ---------------------------------------------------------------------------
router.get('/freeradius-sync', async (req, res) => {
  try {
    const cfg = await keepalived.getHaConfig();
    if (!cfg.track_freeradius) return res.json({ enabled: false });

    const { rows: nasRows } = await pool.query(
      'SELECT * FROM radius_nas WHERE is_active = true ORDER BY shortname'
    );
    const internalSecret = process.env.INTERNAL_SECRET || '';

    res.json({
      enabled:      true,
      clients_conf: keepalived.generateFreeRadiusClients(nasRows),
      rest_conf:    keepalived.generateFreeRadiusRestMod('http://localhost:3001'),
      classguard_conf: keepalived.generateFreeRadiusVirtualServer(internalSecret),
      eap_conf:     keepalived.generateEapMod(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /radius/ldap/test — test Google Secure LDAP connection
router.post('/ldap/test', ...superauth, async (req, res) => {
  try {
    const result = await radiusLdap.testConnection();
    res.json(result);
  } catch (err) { res.status(502).json({ ok: false, reason: err.message }); }
});

// POST /radius/ldap/test-user — runs the real search-then-bind flow against
// a specific account, so an admin can confirm e.g. a students.<domain> or a
// staff <domain> account actually authenticates, not just that the TLS
// connection itself works. The password is never logged or persisted — it
// passes straight through to authenticateUser() (same function FreeRADIUS
// calls in production) and is discarded once this returns.
router.post('/ldap/test-user', ...superauth, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are both required' });
  }
  try {
    const result = await radiusLdap.authenticateUser(username, password);
    res.json(result);
  } catch (err) { res.status(502).json({ ok: false, reason: err.message }); }
});

// POST /radius/ldap/upload — accepts the cert/key files downloaded from
// Google Admin's LDAP client setup and stores them in the shared certs
// volume (same one TLS uses), then saves the resulting paths + base_dn/domain
// as settings. Splitting this from /ldap/test lets the wizard upload once
// and re-test repeatedly without re-uploading.
router.post('/ldap/upload', ...superauth, upload.fields([{ name: 'cert', maxCount: 1 }, { name: 'key', maxCount: 1 }]), async (req, res) => {
  const certFile = req.files?.cert?.[0];
  const keyFile  = req.files?.key?.[0];
  const { base_dn, google_domain } = req.body;

  if (!certFile || !keyFile) return res.status(400).json({ error: 'cert and key files are both required' });
  if (!base_dn) return res.status(400).json({ error: 'base_dn is required' });

  try {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const certPath = path.join(CERT_DIR, 'ldap-client.crt');
    const keyPath  = path.join(CERT_DIR, 'ldap-client.key');
    fs.writeFileSync(certPath, certFile.buffer, { mode: 0o600 });
    fs.writeFileSync(keyPath, keyFile.buffer, { mode: 0o600 });

    const settings = {
      ldap_client_cert_path: certPath,
      ldap_client_key_path:  keyPath,
      ldap_base_dn:           base_dn,
      ldap_google_domain:     google_domain || null,
    };
    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
    }
    radiusLdap.invalidateSettingsCache();
    res.json({ saved: true, certPath, keyPath });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
