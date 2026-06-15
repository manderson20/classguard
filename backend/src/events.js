const { EventEmitter } = require('events');

// Shared in-process event bus.
// Routes emit events here; the Socket.io handler forwards them to connected clients.
// Keeps routes decoupled from the io instance.
const events = new EventEmitter();
events.setMaxListeners(50);

module.exports = events;
