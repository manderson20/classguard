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
// Body: { url, title }
// ---------------------------------------------------------------------------
router.post('/tab-event', authenticate, async (req, res) => {
  const { url, title = '', event = 'navigation' } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const studentId = req.user.userId;

  const ts = Date.now();

  // Write to Redis stream for persistence / audit
  await redis.xadd(
    'classguard:tab-events',
    'MAXLEN', '~', 10000,
    '*',
    'student_id', studentId,
    'url',        url.substring(0, 1000),
    'title',      title.substring(0, 200),
    'event',      event,
    'ts',         ts.toString()
  ).catch(() => {});

  // For an actual navigation (not a tab-closed report), look up the most
  // recent matching dns_logs row so the teacher's live view can show WHY a
  // domain was blocked without a separate polling endpoint — the DNS engine
  // already decided allow/block before the browser ever got here.
  let action = null, block_reason = null;
  if (event === 'navigation') {
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

  // Emit to teacher dashboards via the Socket.io bridge
  events.emit('student:activity', {
    studentId,
    url:   url.substring(0, 1000),
    title: title.substring(0, 200),
    event,
    action,
    block_reason,
    ts,
  });

  res.json({ ok: true });
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
    googleClientId: config.google?.clientId || '',
    version:        config.version,
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

  const conditions = [];
  const params     = [];

  if (student_id) { conditions.push(`s.student_id = $${params.length+1}`); params.push(student_id); }
  if (trigger)    { conditions.push(`s.trigger = $${params.length+1}`);    params.push(trigger); }
  if (flagged !== undefined) {
    conditions.push(`s.ai_flagged = $${params.length+1}`);
    params.push(flagged === 'true');
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
  res.json(rows);
});

// ---------------------------------------------------------------------------
// GET /api/v1/extension/screenshots/:id/image  — stream the PNG file
// ---------------------------------------------------------------------------
router.get('/screenshots/:id/image', authenticate, requireMinRole('teacher'), async (req, res) => {
  const { rows } = await pool.query('SELECT file_path FROM screenshots WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });

  const abs = path.join(SCREENSHOT_DIR, rows[0].file_path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file not found' });

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
