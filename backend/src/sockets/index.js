const jwt = require('jsonwebtoken');
const config = require('../config');

const setupSockets = (io) => {
  // Authenticate socket connections with the same JWT used by the REST API
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

    // Teachers join their class rooms; students join their own room
    socket.on('join:class', (classId) => {
      if (role === 'teacher' || role === 'admin' || role === 'superadmin') {
        socket.join(`class:${classId}`);
      }
    });

    socket.join(`student:${userId}`);

    // Phase 6 — teacher → server commands
    // Phase 6 — server → teacher screenshot/tab events
    // Placeholder handlers will be fleshed out in Phase 6

    socket.on('disconnect', () => {});
  });
};

module.exports = setupSockets;
