// Backend routes called exclusively by the ClassGuard Chrome extension.

const { Router }          = require('express');
const { OAuth2Client }    = require('google-auth-library');
const jwt                 = require('jsonwebtoken');
const fs                  = require('fs');
const path                = require('path');
const config              = require('../config');
const { query, pool }     = require('../db');
const redis               = require('../redis');
const { authenticate }    = require('../middleware/auth');
const { requireMinRole }  = require('../middleware/roles');
const { resolvePolicy }   = require('../services/policyResolver');
const { teacherOwnsStudent } = require('../services/teacherRoster');
const { logDeviceView }   = require('../services/deviceViewAudit');
const events              = require('../events');

// Screenshot storage directory (inside the Docker app-logs volume or local path)
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || path.join(__dirname, '../../screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const router     = Router();
const oauthClient = new OAuth2Client(config.google.clientId);

// ---------------------------------------------------------------------------
// POST /api/v1/extension/auth
// Exchange a Google OAuth access token (from chrome.identity.getAuthToken) for
// a ClassGuard JWT.  The extension cannot do a full code-flow OAuth because it
// runs in a service worker; chrome.identity gives us an access token directly.
// ---------------------------------------------------------------------------
router.post('/auth', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'access_token required' });

  let userInfo;
  try {
    const infoRes = await fetch(
      `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${encodeURIComponent(access_token)}`
    );
    if (!infoRes.ok) throw new Error('Google userinfo rejected the token');
    userInfo = await infoRes.json();
  } catch (err) {
    return res.status(401).json({ error: 'Google token validation failed' });
  }

  const { sub: googleId, email, name: fullName, given_name: givenName, picture: photoUrl, hd: hostedDomain } = userInfo;

  if (config.google.workspaceDomain && hostedDomain !== config.google.workspaceDomain) {
    return res.status(403).json({ error: 'Account domain not authorized for this ClassGuard instance' });
  }

  // Upsert user (extension users are always students unless already assigned another role)
  const { rows } = await query(
    `INSERT INTO users (google_id, email, full_name, given_name, photo_url, role, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,'student',NOW())
     ON CONFLICT (google_id) DO UPDATE SET
       email          = EXCLUDED.email,
       full_name      = EXCLUDED.full_name,
       given_name     = EXCLUDED.given_name,
       photo_url      = EXCLUDED.photo_url,
       last_synced_at = NOW(),
       last_login_at  = NOW(),
       updated_at     = NOW()
     RETURNING *`,
    [googleId, email, fullName, givenName, photoUrl]
  );

  const user = rows[0];
  if (!user.is_active) return res.status(403).json({ error: 'Account is deactivated' });

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  return res.json({
    token,
    user: {
      id:       user.id,
      email:    user.email,
      name:     user.full_name,
      role:     user.role,
      photoUrl: user.photo_url,
    },
  });
});

// ---------------------------------------------------------------------------
// Device identity helpers — the extension itself can't read the host's MAC
// address (no web API exposes that), but the same machine's MAC is already
// known on our side via DHCP (ip_addresses.mac_address, kept current by
// dhcpLeaseIpamSync.js for leases and dhcpIpamSync.js for reservations). So
// rather than trust IP alone — which changes every time a laptop moves
// between buildings/subnets — we resolve "which physical device is at this
// IP right now" via DHCP and key the devices table on that MAC
// (device_identifier), falling back to a per-student best-guess row only
// when no DHCP record exists yet for the IP (e.g. a brand new lease DHCP
// hasn't synced into IPAM yet, or a network we don't manage DHCP for).
// ---------------------------------------------------------------------------
async function resolveMacForIp(ip) {
  const { rows } = await query(
    `SELECT mac_address FROM ip_addresses WHERE ip = $1 AND mac_address IS NOT NULL`,
    [ip]
  );
  return rows[0]?.mac_address || null;
}

// Registers/refreshes the device→student mapping and returns the resolved
// devices.id (or null if no MAC could be resolved for this IP yet).
async function registerDevice(studentId, ip) {
  const mac = await resolveMacForIp(ip).catch(() => null);

  if (mac) {
    const { rows } = await query(
      `INSERT INTO devices (device_identifier, current_user_id, last_ip, last_seen_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (device_identifier) DO UPDATE SET
         current_user_id = EXCLUDED.current_user_id,
         last_ip          = EXCLUDED.last_ip,
         last_seen_at      = NOW()
       RETURNING id`,
      [mac, studentId, ip]
    );
    return rows[0]?.id || null;
  }

  // No DHCP record for this IP (yet) — best-effort fallback so the audit
  // trail and "last seen" data isn't lost, just not MAC-identified. Scoped to
  // the same (student, ip) pair so a transient DHCP lookup miss for an
  // already-MAC-identified device never spawns a duplicate unidentified row.
  const { rowCount } = await query(
    `UPDATE devices SET last_seen_at = NOW() WHERE current_user_id = $1 AND device_identifier IS NULL AND last_ip = $2`,
    [studentId, ip]
  );
  if (rowCount === 0) {
    await query(
      `INSERT INTO devices (current_user_id, last_ip, last_seen_at) VALUES ($1,$2,NOW())`,
      [studentId, ip]
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /api/v1/extension/register
// Registers the device's IP address → student mapping so the DNS engine can
// look up the student's policy from an IP address, and (when DHCP knows the
// MAC at this IP) which physical device — see registerDevice() above.
// ---------------------------------------------------------------------------
router.post('/register', authenticate, async (req, res) => {
  const studentId = req.user.userId;
  const ip        = req.ip || req.socket.remoteAddress;

  const deviceId = await registerDevice(studentId, ip).catch(() => null);
  // Store in Redis so the DNS engine can find it; TTL = 8h (matches JWT)
  await redis.set(`device:${ip}`, JSON.stringify({ studentId, deviceId }), 'EX', 8 * 60 * 60);

  res.json({ ok: true, ip });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/heartbeat
// Periodic liveness signal from the extension (~every 30 s).
// Also re-registers the IP → student mapping so it doesn't expire.
// Body: { url?, title?, socket? }
// ---------------------------------------------------------------------------
router.post('/heartbeat', authenticate, async (req, res) => {
  const studentId = req.user.userId;
  const ip        = req.ip || req.socket.remoteAddress;

  const deviceId = await registerDevice(studentId, ip).catch(() => null);
  // Refresh IP → student mapping
  await redis.set(`device:${ip}`, JSON.stringify({ studentId, deviceId }), 'EX', 8 * 60 * 60);

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/tab-event
// Reports a student's browser navigation to the backend.
// Teachers can see this in real-time via the dashboard (Phase 6).
// Body: { url, title, is_direct_ip?, blocked? }
//
// is_direct_ip/blocked come from the extension's own webNavigation listener
// (chrome-extension/src/lib/directIp.js) for navigations straight to a
// literal IP address — dns-engine structurally never sees these (no DNS
// query happens), so there's no dns_logs row to look up; the extension
// already knows whether its own policy.block_direct_ip would block it,
// since it computed that from the exact same cached policy DNR enforcement
// uses, so it's passed through directly instead of re-derived here.
// ---------------------------------------------------------------------------
router.post('/tab-event', authenticate, async (req, res) => {
  const { url, title = '', event = 'navigation', is_direct_ip = false, blocked = false } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const studentId = req.user.userId;
  const ip        = req.ip || req.socket.remoteAddress;

  const ts = Date.now();

  // device_id from the same Redis device:{ip} mapping heartbeat maintains —
  // browser_history is keyed the same way dns_logs already is, so a
  // student's history and DNS history can be correlated by device.
  let deviceId = null;
  try {
    const cached = await redis.get(`device:${ip}`);
    if (cached) deviceId = JSON.parse(cached).deviceId || null;
  } catch { /* not fatal — history just won't have a device_id for this row */ }

  let action = null, block_reason = null;
  if (is_direct_ip) {
    action       = blocked ? 'blocked' : 'allowed';
    block_reason = blocked ? 'direct_ip' : null;
  } else if (event === 'navigation') {
    // For an actual navigation (not a tab-closed report), look up the most
    // recent matching dns_logs row so both the teacher's live view AND the
    // persisted browser_history row can show WHY a domain was blocked,
    // without a separate polling endpoint — the DNS engine already decided
    // allow/block before the browser ever got here.
    try {
      const hostname = new URL(url).hostname;
      const { rows } = await query(
        `SELECT action, block_reason FROM dns_logs
         WHERE user_id = $1 AND domain = $2
         ORDER BY queried_at DESC LIMIT 1`,
        [studentId, hostname]
      );
      if (rows[0]) { action = rows[0].action; block_reason = rows[0].block_reason; }
    } catch { /* malformed URL — skip the lookup, not fatal */ }
  }

  // Write to Redis stream — drained to browser_history by
  // scheduler.js's drainTabEvents() every 5s. MAXLEN is just a safety cap in
  // case the drain falls behind/is down; normal operation never gets close.
  await redis.xadd(
    'classguard:tab-events',
    'MAXLEN', '~', 50000,
    '*',
    'student_id',   studentId,
    'device_id',    deviceId || '',
    'url',          url.substring(0, 1000),
    'title',        title.substring(0, 200),
    'event',        event,
    'action',       action || '',
    'block_reason', block_reason || '',
    'is_direct_ip', is_direct_ip ? '1' : '0',
    'ts',           ts.toString()
  ).catch(() => {});

  // Emit to teacher dashboards via the Socket.io bridge
  events.emit('student:activity', {
    studentId,
    url:   url.substring(0, 1000),
    title: title.substring(0, 200),
    event,
    action,
    block_reason,
    is_direct_ip,
    ts,
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/internal/tab-events/bulk
// Internal-secret only. A standby node forwards browser-history events here
// when its own Postgres is a read-only streaming replica — see
// services/scheduler.js's insertOrForwardBrowserHistory. Same role as
// routes/dns.js's /internal/dns-logs/bulk for dns_logs.
// ---------------------------------------------------------------------------
router.post('/internal/tab-events/bulk', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records (non-empty array) is required' });
  }
  try {
    const { insertBrowserHistoryBatch } = require('../services/scheduler');
    await insertBrowserHistoryBatch(records);
    res.json({ inserted: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/extension/browser-history
// Persisted tab-navigation history (browser_history, drained from the same
// Redis stream that powers the live teacher view). Mirrors routes/dns.js's
// GET /dns/logs filtering/pagination/teacher-scoping shape.
//
// Query params: student_id, url (substring match), action, is_direct_ip, from, to, page, limit
// ---------------------------------------------------------------------------
router.get('/browser-history', authenticate, requireMinRole('teacher'), async (req, res) => {
  const {
    student_id, url, action, is_direct_ip,
    from, to,
    page = 1, limit = 50,
  } = req.query;

  const PAGE_LIMIT = Math.min(parseInt(limit, 10) || 50, 500);
  const OFFSET     = (Math.max(parseInt(page, 10) || 1, 1) - 1) * PAGE_LIMIT;

  const conditions = [];
  const values     = [];

  const fromTs = from ? new Date(from) : new Date(Date.now() - 86400_000);
  const toTs   = to   ? new Date(to)   : new Date();

  conditions.push(`visited_at >= $${values.length + 1}`); values.push(fromTs);
  conditions.push(`visited_at <= $${values.length + 1}`); values.push(toTs);

  if (student_id) {
    conditions.push(`user_id = $${values.length + 1}`);
    values.push(student_id);
  }
  if (url) {
    conditions.push(`url ILIKE $${values.length + 1}`);
    values.push(`%${url}%`);
  }
  if (action && ['allowed', 'blocked'].includes(action)) {
    conditions.push(`action = $${values.length + 1}`);
    values.push(action);
  }
  if (is_direct_ip === 'true') {
    conditions.push(`is_direct_ip = true`);
  }

  // Teachers can only see their own students — same scoping as dns.js's /logs
  if (req.user.role === 'teacher') {
    conditions.push(`user_id IN (
      SELECT cm.student_id FROM class_members cm
      JOIN classes c ON c.id = cm.class_id
      WHERE c.teacher_id = $${values.length + 1}
    )`);
    values.push(req.user.userId);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [{ rows: history }, { rows: countRow }] = await Promise.all([
    query(
      `SELECT bh.*, u.full_name AS student_name, u.email AS student_email
       FROM browser_history bh
       LEFT JOIN users u ON u.id = bh.user_id
       ${where}
       ORDER BY bh.visited_at DESC
       LIMIT ${PAGE_LIMIT} OFFSET ${OFFSET}`,
      values
    ),
    query(`SELECT COUNT(*) AS total FROM browser_history ${where}`, values),
  ]);

  res.json({
    total:   parseInt(countRow[0].total, 10),
    page:    parseInt(page, 10),
    limit:   PAGE_LIMIT,
    results: history,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/extension/policy
// Returns the student's effective policy (same as /users/me/effective-policy
// but also accepted by the extension without a double-auth round-trip).
// ---------------------------------------------------------------------------
router.get('/policy', authenticate, async (req, res) => {
  const policy = await resolvePolicy(req.user.userId);
  res.json(policy);
});

// ---------------------------------------------------------------------------
// GET /api/v1/extension/managed-config
// Returns the public server config that the extension needs.
// This is unauthenticated so unregistered devices can bootstrap.
// ---------------------------------------------------------------------------
router.get('/managed-config', (req, res) => {
  res.json({
    serverUrl:      config.appUrl || process.env.APP_URL || '',
    version:        config.version,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/extension/build-config
// Internal-only (x-internal-secret) — polled by the extension-builder's
// watch loop so the Chrome extension's OAuth client ID and public URL come
// from Settings > Integrations > Chrome Extension (stored in Postgres,
// already replicated across HA nodes) instead of per-node .env editing.
//
// publicUrl resolution order: explicit override -> the live TLS domain (the
// one actually serving HTTPS, since chrome.identity/CRX downloads require it)
// -> APP_URL as a last-resort dev fallback.
// ---------------------------------------------------------------------------
router.get('/build-config', authenticate, requireMinRole('admin'), async (req, res) => {
  const { rows } = await query(
    `SELECT key, value FROM settings WHERE key IN ('extension_oauth_client_id','extension_public_url')`
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

  let publicUrl = map.extension_public_url || null;
  let urlSource  = 'override';
  if (!publicUrl) {
    const { rows: tls } = await query(
      `SELECT domain FROM tls_config WHERE enabled = true AND domain IS NOT NULL LIMIT 1`
    );
    if (tls[0]?.domain) {
      publicUrl = `https://${tls[0].domain}`;
      urlSource = 'tls_config';
    } else {
      publicUrl = process.env.APP_URL || '';
      urlSource = 'app_url_fallback';
    }
  }

  res.json({
    googleClientId: map.extension_oauth_client_id || '',
    publicUrl,
    urlSource,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/extension/keywords
// Returns the active keyword list for in-extension content scanning.
// Returned as a compact array — extension does local matching, never sends text.
// ---------------------------------------------------------------------------
router.get('/keywords', authenticate, async (req, res) => {
  const { rows } = await query(
    `SELECT keyword, category FROM content_keywords WHERE is_active = true ORDER BY keyword`
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/screenshot
// Receives a screenshot (PNG data URL) from the extension.
// Body: { data_url, url, title, trigger, trigger_detail }
// ---------------------------------------------------------------------------
router.post('/screenshot', authenticate, async (req, res) => {
  const { data_url, url, title, trigger = 'manual', trigger_detail } = req.body;

  if (!data_url || !url) return res.status(400).json({ error: 'data_url and url required' });

  // Strip the data URL header and decode
  const matches = data_url.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
  if (!matches) return res.status(400).json({ error: 'invalid data_url format' });

  const ext    = matches[1];
  const buffer = Buffer.from(matches[2], 'base64');

  // Store in YYYY/MM/DD subdirectory
  const now     = new Date();
  const dateDir = path.join(SCREENSHOT_DIR,
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dateDir, { recursive: true });

  const filename  = `${Date.now()}-${req.user.userId.slice(0, 8)}.${ext}`;
  const filePath  = path.join(dateDir, filename);
  const relPath   = path.relative(SCREENSHOT_DIR, filePath);

  fs.writeFileSync(filePath, buffer);

  const { rows } = await query(
    `INSERT INTO screenshots
       (student_id, url, page_title, trigger, trigger_detail, file_path, file_size)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [req.user.userId, url.substring(0, 2000), title?.substring(0, 500) || null,
     trigger, trigger_detail || null, relPath, buffer.length]
  );

  const screenshot = rows[0];

  // Emit to teacher dashboards
  events.emit('student:screenshot', {
    studentId:    req.user.userId,
    screenshotId: screenshot.id,
    url,
    trigger,
    trigger_detail,
    created_at: screenshot.created_at,
  });

  // Kick off async AI analysis for violation triggers
  if (trigger === 'content_violation' || trigger === 'policy_block') {
    analyseScreenshot(screenshot.id, filePath, buffer).catch(() => {});
  }

  res.json({ ok: true, id: screenshot.id });
});

// Fire-and-forget AI vision analysis
async function analyseScreenshot(screenshotId, filePath, buffer) {
  const { rows: cfg } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('ai_provider','ai_api_key','ai_model')`
  );
  const settings = Object.fromEntries(cfg.map(r => [r.key, r.value]));
  if (!settings.ai_provider || settings.ai_provider === 'none') return;

  try {
    let result = null;

    if (settings.ai_provider === 'claude') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: settings.ai_api_key });
      const response = await client.messages.create({
        model: settings.ai_model || 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') } },
            { type: 'text', text: 'Analyze this school browser screenshot for inappropriate content. Respond with JSON only: {"flagged": bool, "category": "adult|violence|self_harm|profanity|other|safe", "confidence": 0.0-1.0, "reasoning": "one sentence"}' },
          ],
        }],
      });
      result = JSON.parse(response.content[0].text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    } else if (settings.ai_provider === 'openai') {
      const axios = require('axios');
      const r = await axios.post(
        `${settings.ai_base_url || 'https://api.openai.com'}/v1/chat/completions`,
        {
          model: settings.ai_model || 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${buffer.toString('base64')}` } },
              { type: 'text', text: 'Is this school browser screenshot inappropriate? JSON only: {"flagged": bool, "category": "adult|violence|self_harm|profanity|other|safe", "confidence": 0.0-1.0, "reasoning": "one sentence"}' },
            ],
          }],
          max_tokens: 256,
        },
        { headers: { Authorization: `Bearer ${settings.ai_api_key}` } }
      );
      result = JSON.parse(r.data.choices[0].message.content.match(/\{[\s\S]*\}/)?.[0] || '{}');
    }

    if (result && typeof result.flagged === 'boolean') {
      await pool.query(
        `UPDATE screenshots SET ai_flagged = $1, ai_category = $2, ai_confidence = $3, ai_reasoning = $4
         WHERE id = $5`,
        [result.flagged, result.category, result.confidence, result.reasoning, screenshotId]
      );
    }
  } catch (err) {
    console.error('[screenshot/ai]', err.message);
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/extension/screenshots  — admin/teacher list
// ---------------------------------------------------------------------------
router.get('/screenshots', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { student_id, trigger, flagged, limit = 50, offset = 0 } = req.query;

  // A teacher could previously browse ANY student's screenshots, not just
  // their own roster — requireMinRole('teacher') only checked role, never
  // ownership. Admins/superadmins are intentionally not roster-limited
  // (that's the point of the Live View feature too), but a teacher is.
  if (req.user.role === 'teacher') {
    if (student_id) {
      if (!(await teacherOwnsStudent(req.user.userId, student_id))) {
        return res.status(403).json({ error: 'This student is not on one of your rosters' });
      }
    } else {
      // No student_id filter: restrict the whole list to the teacher's roster
      // rather than letting it return every student in the district.
    }
  }

  const conditions = [];
  const params     = [];

  if (student_id) { conditions.push(`s.student_id = $${params.length+1}`); params.push(student_id); }
  if (trigger)    { conditions.push(`s.trigger = $${params.length+1}`);    params.push(trigger); }
  if (flagged !== undefined) {
    conditions.push(`s.ai_flagged = $${params.length+1}`);
    params.push(flagged === 'true');
  }
  if (req.user.role === 'teacher' && !student_id) {
    conditions.push(`s.student_id IN (
      SELECT cm.student_id FROM class_members cm
      JOIN classes c ON c.id = cm.class_id
      WHERE c.teacher_id = $${params.length+1}
    )`);
    params.push(req.user.userId);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT s.*, u.full_name AS student_name, u.email AS student_email
     FROM screenshots s
     JOIN users u ON u.id = s.student_id
     ${where}
     ORDER BY s.created_at DESC
     LIMIT $${params.length+1} OFFSET $${params.length+2}`,
    [...params, limit, offset]
  );

  // Logged only for the targeted "this one student's screenshots" case —
  // an unfiltered roster browse isn't the single-student-stalking risk
  // this audit trail exists for, and doesn't map cleanly onto a schema
  // that requires exactly one student per row.
  if (student_id) {
    logDeviceView({
      viewerId: req.user.userId, studentId: student_id, action: 'screenshot_list_viewed',
      detail: { count: rows.length, trigger: trigger || null },
    }).catch(err => console.error('[device-view-audit] log failed:', err.message));
  }

  res.json(rows);
});

// ---------------------------------------------------------------------------
// GET /api/v1/extension/screenshots/:id/image  — stream the PNG file
// ---------------------------------------------------------------------------
router.get('/screenshots/:id/image', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { rows } = await pool.query('SELECT file_path, student_id FROM screenshots WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });

  if (req.user.role === 'teacher' && !(await teacherOwnsStudent(req.user.userId, rows[0].student_id))) {
    return res.status(403).json({ error: 'This student is not on one of your rosters' });
  }

  const abs = path.join(SCREENSHOT_DIR, rows[0].file_path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file not found' });

  logDeviceView({
    viewerId: req.user.userId, studentId: rows[0].student_id, action: 'screenshot_viewed',
    detail: { screenshot_id: req.params.id },
  }).catch(err => console.error('[device-view-audit] log failed:', err.message));

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(abs).pipe(res);
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/screenshots/:id/review
// Teacher/admin marks a screenshot as reviewed
// ---------------------------------------------------------------------------
router.post('/screenshots/:id/review', authenticate, requireMinRole('teacher'), async (req, res) => {
  await pool.query(
    'UPDATE screenshots SET reviewed_by = $1, reviewed_at = NOW() WHERE id = $2',
    [req.user.userId, req.params.id]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/request-screenshot
// Teacher requests a live screenshot from a student's device via Socket.io.
// Body: { student_id }
// ---------------------------------------------------------------------------
router.post('/request-screenshot', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { student_id } = req.body;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });

  if (req.user.role === 'teacher' && !(await teacherOwnsStudent(req.user.userId, student_id))) {
    return res.status(403).json({ error: 'This student is not on one of your rosters' });
  }

  // Emit to the student's connected extension socket
  events.emit('teacher:screenshot_request', {
    studentId:   student_id,
    requestedBy: req.user.userId,
  });

  res.json({ ok: true, message: 'Screenshot request sent to device' });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extension/liveview-frame
// One frame for the admin Live View feature (routes/liveView.js). Unlike
// POST /screenshot above, this is NEVER written to disk or the screenshots
// table — it's relayed straight through to whoever's currently watching
// (sockets/index.js's liveview:${studentId} room) and then discarded. A
// continuous stream of permanently-stored images from this would be a much
// bigger privacy footprint than the feature needs, and screenshots already
// have no retention/cleanup job (see migration 015's comment) — this
// deliberately doesn't add to that pile.
// Body: { data_url, url, title }
// ---------------------------------------------------------------------------
router.post('/liveview-frame', authenticate, async (req, res) => {
  const { data_url, url, title } = req.body;
  if (!data_url || !/^data:image\/(png|jpeg|webp);base64,/.test(data_url)) {
    return res.status(400).json({ error: 'invalid data_url format' });
  }

  events.emit('student:liveview_frame', {
    studentId: req.user.userId,
    dataUrl:   data_url,
    url:       url || null,
    title:     title || null,
    capturedAt: new Date().toISOString(),
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Remote device commands — lock/unlock screen, open/close tab. Same shape as
// request-screenshot above: authenticate, verify roster ownership, emit a
// teacher:* event for sockets/index.js to relay to the student's extension,
// log to teacher_actions for accountability.
// ---------------------------------------------------------------------------
async function logTeacherAction(req, student_id, action_type, detail = null) {
  let classId = null;
  try {
    const { rows } = await query(
      `SELECT cm.class_id FROM class_members cm
       JOIN classes c ON c.id = cm.class_id
       WHERE cm.student_id = $1 AND c.teacher_id = $2 LIMIT 1`,
      [student_id, req.user.userId]
    );
    classId = rows[0]?.class_id || null;
  } catch { /* best-effort, audit log shouldn't block the action */ }
  await query(
    `INSERT INTO teacher_actions (teacher_id, student_id, class_id, action_type, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.user.userId, student_id, classId, action_type, detail]
  ).catch(() => {});
}

router.post('/lock-request', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { student_id, message } = req.body;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });
  if (req.user.role === 'teacher' && !(await teacherOwnsStudent(req.user.userId, student_id))) {
    return res.status(403).json({ error: 'This student is not on one of your rosters' });
  }
  events.emit('teacher:lock_request', { studentId: student_id, message: message || null });
  await logTeacherAction(req, student_id, 'lock', message || null);
  res.json({ ok: true });
});

router.post('/unlock-request', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { student_id } = req.body;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });
  if (req.user.role === 'teacher' && !(await teacherOwnsStudent(req.user.userId, student_id))) {
    return res.status(403).json({ error: 'This student is not on one of your rosters' });
  }
  events.emit('teacher:unlock_request', { studentId: student_id });
  await logTeacherAction(req, student_id, 'unlock');
  res.json({ ok: true });
});

router.post('/open-tab-request', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { student_id, url } = req.body;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });
  if (req.user.role === 'teacher' && !(await teacherOwnsStudent(req.user.userId, student_id))) {
    return res.status(403).json({ error: 'This student is not on one of your rosters' });
  }
  events.emit('teacher:open_tab_request', { studentId: student_id, url: url || null });
  await logTeacherAction(req, student_id, 'open_tab', url || null);
  res.json({ ok: true });
});

router.post('/close-tab-request', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { student_id } = req.body;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });
  if (req.user.role === 'teacher' && !(await teacherOwnsStudent(req.user.userId, student_id))) {
    return res.status(403).json({ error: 'This student is not on one of your rosters' });
  }
  events.emit('teacher:close_tab_request', { studentId: student_id });
  await logTeacherAction(req, student_id, 'close_tab');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Keyword management (admin)
// ---------------------------------------------------------------------------
router.get('/keywords/manage', authenticate, requireMinRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM content_keywords ORDER BY category, keyword'
  );
  res.json(rows);
});

router.post('/keywords', authenticate, requireMinRole('admin'), async (req, res) => {
  const { keyword, category } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  const { rows } = await pool.query(
    `INSERT INTO content_keywords (keyword, category, added_by)
     VALUES (lower($1),$2,$3) ON CONFLICT (keyword) DO UPDATE SET is_active=true RETURNING *`,
    [keyword.trim(), category || 'profanity', req.user.userId]
  );
  res.status(201).json(rows[0]);
});

router.delete('/keywords/:id', authenticate, requireMinRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM content_keywords WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

module.exports = router;
