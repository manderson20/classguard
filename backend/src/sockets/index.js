const jwt    = require('jsonwebtoken');
const config = require('../config');
const events = require('../events');
const { query } = require('../db');
const redis  = require('../redis');

const setupSockets = (io) => {
  // Authenticate every socket connection with the same JWT used by the REST API
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.user = jwt.verify(token, config.jwt.secret);
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, role } = socket.user;

    // Every student joins their own private room so we can push policy updates
    socket.join(`student:${userId}`);

    // Every staff member auto-joins this room (no explicit join call needed,
    // unlike class rooms below) so an urgent safety alert reaches whoever's
    // logged in right now, not just whichever class room they happen to
    // have open.
    if (['teacher', 'admin', 'superadmin'].includes(role)) {
      socket.join('role:staff');
    }

    // Infra/ops events (e.g. an HA node auto-promoting its database) are
    // meaningless noise to a teacher or building admin and only meant for
    // whoever can actually act on them.
    if (role === 'superadmin') {
      socket.join('role:superadmin');
    }

    // Teachers and admins join class rooms on demand (called by the dashboard)
    socket.on('join:class', (classId) => {
      if (['teacher','admin','superadmin'].includes(role)) {
        socket.join(`class:${classId}`);
      }
    });

    socket.on('leave:class', (classId) => {
      socket.leave(`class:${classId}`);
    });

    // Admin Live View (routes/liveView.js) — not roster-scoped like
    // join:class above, so restricted to admin+ rather than any teacher.
    // The actual permission/audit-logging gate is the HTTP /start route;
    // this just controls who receives the relayed frames over the socket.
    socket.on('join:liveview', (studentId) => {
      if (['admin', 'superadmin'].includes(role)) {
        socket.join(`liveview:${studentId}`);
      }
    });

    socket.on('leave:liveview', (studentId) => {
      socket.leave(`liveview:${studentId}`);
    });

    socket.on('disconnect', () => {});
  });

  // ---------------------------------------------------------------------------
  // Internal event bus → WebSocket bridge
  // ---------------------------------------------------------------------------

  // Policy updates: push to student's extension so it reloads its DNR rules
  events.on('policy:updated', ({ studentId }) => {
    if (studentId) {
      io.to(`student:${studentId}`).emit('policy:updated', { studentId });
    }
  });

  // Student tab activity: forward to all class rooms the student belongs to
  // Uses a Redis-cached class membership list (TTL 5 min) to avoid a DB query
  // on every browser navigation.
  events.on('student:activity', async ({ studentId, url, title, ts, event, action, block_reason }) => {
    if (!studentId) return;

    try {
      const cacheKey = `student:classes:${studentId}`;
      let classIds;

      const cached = await redis.get(cacheKey);
      if (cached) {
        classIds = JSON.parse(cached);
      } else {
        const { rows } = await query(
          'SELECT class_id FROM class_members WHERE student_id = $1',
          [studentId]
        );
        classIds = rows.map(r => r.class_id);
        await redis.set(cacheKey, JSON.stringify(classIds), 'EX', 300);
      }

      const payload = { studentId, url, title, ts, event, action, block_reason };
      for (const classId of classIds) {
        io.to(`class:${classId}`).emit('student:activity', payload);
      }
    } catch (err) {
      console.error('[socket] student:activity forwarding error:', err.message);
    }
  });

  // Lockdown escape attempt: forward to the owning class room so the
  // teacher's live ActiveLesson view shows it as it happens.
  events.on('lockdown:event', ({ studentId, classId, sessionId, eventType, detail }) => {
    if (!classId) return;
    io.to(`class:${classId}`).emit('lockdown:event', { studentId, sessionId, eventType, detail, ts: Date.now() });
  });

  // Screenshot captured: notify all class rooms the student belongs to
  events.on('student:screenshot', async ({ studentId, screenshotId, url, trigger, created_at }) => {
    if (!studentId) return;
    try {
      const cacheKey = `student:classes:${studentId}`;
      const cached   = await redis.get(cacheKey);
      const classIds = cached ? JSON.parse(cached) : [];
      const payload  = { studentId, screenshotId, url, trigger, created_at };
      for (const classId of classIds) {
        io.to(`class:${classId}`).emit('student:screenshot', payload);
      }
    } catch {}
  });

  // High-severity safety event (risk_score >= 85) — broadcast to every
  // logged-in staff member immediately, not just the student's own
  // teachers, since self-harm/violence-tier content warrants everyone
  // seeing it, not just whoever happens to have that class room open.
  events.on('safety:urgent_alert', (payload) => {
    io.to('role:staff').emit('safety:urgent_alert', payload);
  });

  // Upstream internet/DNS outage or recovery — same staff-wide broadcast as
  // the safety alert above, distinct event name/banner since this is an
  // infra concern, not a student-safety one.
  events.on('system:internet_alert', (payload) => {
    io.to('role:staff').emit('system:internet_alert', payload);
  });

  // Filter bypass detection -- a student-safety event (the filter has
  // stopped applying to this device, same audience as urgent_alert above),
  // not an infra one.
  events.on('safety:filter_bypass', (payload) => {
    io.to('role:staff').emit('safety:filter_bypass', payload);
  });

  // HA auto-promotion firing is an infra/ops event, not a student-safety or
  // general-staff one — superadmins only (see sockets join logic above).
  events.on('system:ha_auto_promote', (payload) => {
    io.to('role:superadmin').emit('system:ha_auto_promote', payload);
  });

  // Teacher-initiated screenshot request: push to student's extension socket
  events.on('teacher:screenshot_request', ({ studentId }) => {
    if (studentId) {
      io.to(`student:${studentId}`).emit('screenshot:request');
    }
  });

  // Admin Live View: ask the student's extension for one frame, then relay
  // whatever comes back to anyone currently watching that student. Nothing
  // here touches the database — see /extension/liveview-frame's comment for
  // why this is deliberately ephemeral.
  events.on('admin:liveview_request', ({ studentId }) => {
    if (studentId) {
      io.to(`student:${studentId}`).emit('liveview:request');
    }
  });

  events.on('student:liveview_frame', ({ studentId, dataUrl, url, title, capturedAt }) => {
    if (studentId) {
      io.to(`liveview:${studentId}`).emit('liveview:frame', { studentId, dataUrl, url, title, capturedAt });
    }
  });

  // Remote device commands — same shape as screenshot_request above, one
  // event in, one matching command out to the student's extension socket.
  events.on('teacher:lock_request', ({ studentId, message }) => {
    if (studentId) io.to(`student:${studentId}`).emit('lock:engage', { message });
  });

  events.on('teacher:unlock_request', ({ studentId }) => {
    if (studentId) io.to(`student:${studentId}`).emit('lock:release');
  });

  events.on('teacher:open_tab_request', ({ studentId, url }) => {
    if (studentId) io.to(`student:${studentId}`).emit('tab:open', { url });
  });

  events.on('teacher:close_tab_request', ({ studentId }) => {
    if (studentId) io.to(`student:${studentId}`).emit('tab:close');
  });

  // Chat — every authenticated socket (student or staff) already joins its
  // own private room on connect (see above), so this same room works for
  // delivering to a teacher's own browser session, not just the extension.
  events.on('chat:new_message', ({ threadId, message, recipientIds }) => {
    for (const id of recipientIds || []) {
      io.to(`student:${id}`).emit('chat:message', { threadId, message });
    }
  });
};

module.exports = setupSockets;
