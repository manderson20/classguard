require('dotenv').config();
const http    = require('http');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const { rateLimit } = require('express-rate-limit');
const { Server }    = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

const config          = require('./config');
const setupSockets    = require('./sockets');
const { startScheduler } = require('./services/scheduler');
const { startHeartbeat } = require('./routes/ha');

const app    = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
app.use(helmet());

// ---------------------------------------------------------------------------
// CORS — allow the React frontend origin
// ---------------------------------------------------------------------------
app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}));

// ---------------------------------------------------------------------------
// Rate limiting — 100 requests per 15 minutes on all /api routes
// ---------------------------------------------------------------------------
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/v1/auth',        require('./routes/auth'));
app.use('/api/v1/users',       require('./routes/users'));
app.use('/api/v1/groups',      require('./routes/groups'));
app.use('/api/v1/policies',    require('./routes/policies'));
app.use('/api/v1/assignments', require('./routes/assignments'));
app.use('/api/v1/blocklists',  require('./routes/blocklists'));
app.use('/api/v1/dns',         require('./routes/dns'));
app.use('/api/v1/penalty-box', require('./routes/penaltyBox'));
app.use('/api/v1/classes',     require('./routes/classes'));
app.use('/api/v1/extension',   require('./routes/extension'));
app.use('/api/v1/sync',        require('./routes/sync'));
app.use('/api/v1/dhcp',        require('./routes/dhcp'));
app.use('/api/v1/ipam',        require('./routes/ipam'));
app.use('/api/v1/settings',      require('./routes/settings'));
app.use('/api/v1/integrations',  require('./routes/integrations'));
app.use('/api/v1/ha',            require('./routes/ha'));
app.use('/api/v1/ntp',           require('./routes/ntp'));
app.use('/api/v1/ai',            require('./routes/ai'));
app.use('/metrics',              require('./routes/metrics'));

// Health check — used by Docker, load balancers, and the HA node registry
app.get('/health', async (req, res) => {
  const { pool } = require('./db');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', node: config.node.id, version: process.env.npm_package_version });
  } catch {
    res.status(503).json({ status: 'error', node: config.node.id, detail: 'database unreachable' });
  }
});

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Socket.io — Redis adapter enables multi-node pub/sub
// ---------------------------------------------------------------------------
const io = new Server(server, {
  cors: { origin: config.frontendUrl, methods: ['GET', 'POST'] },
});

(async () => {
  try {
    const pubClient = new Redis(config.redis.url);
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
  } catch {
    console.warn('Redis adapter unavailable — Socket.io running in single-node mode');
  }
})();

setupSockets(io);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const shutdown = async (signal) => {
  console.log(`${signal} received — shutting down`);
  server.close(async () => {
    const { pool } = require('./db');
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(config.port, () => {
  console.log(`ClassGuard API  →  http://localhost:${config.port}  [${config.nodeEnv}]`);
  startScheduler();
  startHeartbeat();
});

module.exports = { app, io };
