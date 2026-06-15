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
  events.on('student:activity', async ({ studentId, url, title, ts }) => {
    if (!studentId) return;

    try {
      const cacheKey = `student:classes:${studentId}`;
      let classIds;

      const cached = await redis.get(cacheKey);
      if (cached) {
        classIds = JSON.parse(cached);
      } else {
        const { rows } = await query(
          'SELECT class_id FROM class_members WHERE user_id = $1',
          [studentId]
        );
        classIds = rows.map(r => r.class_id);
        await redis.set(cacheKey, JSON.stringify(classIds), 'EX', 300);
      }

      const payload = { studentId, url, title, ts };
      for (const classId of classIds) {
        io.to(`class:${classId}`).emit('student:activity', payload);
      }
    } catch (err) {
      console.error('[socket] student:activity forwarding error:', err.message);
    }
  });
};

module.exports = setupSockets;
