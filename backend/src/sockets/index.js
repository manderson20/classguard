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

    // Teachers and admins join class rooms on demand (called by the dashboard)
    socket.on('join:class', (classId) => {
      if (['teacher','admin','superadmin'].includes(role)) {
        socket.join(`class:${classId}`);
      }
    });

    socket.on('leave:class', (classId) => {
      socket.leave(`class:${classId}`);
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

  // Teacher-initiated screenshot request: push to student's extension socket
  events.on('teacher:screenshot_request', ({ studentId }) => {
    if (studentId) {
      io.to(`student:${studentId}`).emit('screenshot:request');
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
