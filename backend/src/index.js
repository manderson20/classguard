require('dotenv').config();
const http    = require('http');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
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

// Trust the nginx reverse proxy (one hop) so req.ip reflects the real client
// from X-Forwarded-For — without this, every request behind nginx resolves
// to the same address, which collapses rate limiting into one shared bucket
// across every client instead of one bucket per client.
app.set('trust proxy', 1);

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
// Rate limiting — this only needs to stop *unauthenticated* abuse (anonymous
// probing, brute force) — once a request carries a JWT that actually
// verifies, the limiter does nothing useful by throttling it too: the route
// itself already re-checks the token, and an admin with several dashboard
// tabs open generates far more than a "normal" request volume legitimately.
// So: a real (signature-verified) Bearer token skips this limiter entirely;
// anonymous traffic still gets a generous backstop. Login/auth keeps its
// own separate, much stricter limiter since that's the actual brute-force
// surface (see routes/auth.js) and by definition has no token yet.
// ---------------------------------------------------------------------------
function hasValidToken(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  try {
    jwt.verify(header.slice(7), config.jwt.secret);
    return true;
  } catch {
    return false;
  }
}

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: hasValidToken,
}));

// ---------------------------------------------------------------------------
// ACME HTTP-01 challenge — Let's Encrypt's validator fetches this directly
// over plain HTTP, unauthenticated, at the bare (non-/api) path. nginx proxies
// it straight through (see frontend/nginx.conf). See services/acmeTls.js.
// ---------------------------------------------------------------------------
app.get('/.well-known/acme-challenge/:token', (req, res) => {
  const keyAuth = require('./services/acmeTls').getHttp01KeyAuth(req.params.token);
  if (!keyAuth) return res.status(404).end();
  res.type('text/plain').send(keyAuth);
});

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------
// 20mb to comfortably fit a JSON-escaped PHPiPAM mysqldump upload (see
// routes/ipam.js POST /import/phpipam-dump) — everything else stays well under this.
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Impersonation audit — logs every mutating request made while an admin is
// "viewing as" a teacher (see routes/impersonation.js). Needs req.body, so
// it has to run after the body-parsing block above; needs to see every
// router, so it's global rather than per-route.
// ---------------------------------------------------------------------------
app.use(require('./middleware/impersonationAudit').impersonationAuditLogger);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/v1/auth',        require('./routes/auth'));
app.use('/api/v1/users',       require('./routes/users'));
app.use('/api/v1/impersonation', require('./routes/impersonation'));
app.use('/api/v1/groups',      require('./routes/groups'));
app.use('/api/v1/custom-roles', require('./routes/customRoles'));
app.use('/api/v1/policies',    require('./routes/policies'));
app.use('/api/v1/assignments', require('./routes/assignments'));
app.use('/api/v1/blocklists',  require('./routes/blocklists'));
app.use('/api/v1/categories',  require('./routes/categories'));
app.use('/api/v1/dns',         require('./routes/dns'));
app.use('/api/v1/dns',         require('./routes/dnsRecords'));
app.use('/api/v1/penalty-box', require('./routes/penaltyBox'));
app.use('/api/v1/classes',     require('./routes/classes'));
app.use('/api/v1/scenes',      require('./routes/scenes'));
app.use('/api/v1/extension',   require('./routes/extension'));
app.use('/api/v1/sync',        require('./routes/sync'));
app.use('/api/v1/dhcp',        require('./routes/dhcp'));
app.use('/api/v1/dhcpv6',      require('./routes/dhcpv6'));
app.use('/api/v1/ipam',        require('./routes/ipam'));
app.use('/api/v1/youtube',       require('./routes/youtube'));
app.use('/api/v1/branding',         require('./routes/branding'));
app.use('/api/v1/unblock-requests', require('./routes/unblockRequests'));
app.use('/api/v1/screen-time',      require('./routes/screenTime'));
app.use('/api/v1/bell-schedule',    require('./routes/bellSchedule'));
app.use('/api/v1/lockdown',         require('./routes/lockdown'));
app.use('/api/v1/override-codes',   require('./routes/overrideCodes'));
app.use('/api/v1/settings',      require('./routes/settings'));
app.use('/api/v1/integrations',  require('./routes/integrations'));
app.use('/api/v1/ha',            require('./routes/ha'));
app.use('/api/v1/ntp',           require('./routes/ntp'));
app.use('/api/v1/ai',            require('./routes/ai'));
app.use('/api/v1/network',       require('./routes/network'));
app.use('/api/v1/roster',        require('./routes/roster'));
app.use('/api/v1/radius',        require('./routes/radius'));
app.use('/api/v1/tls',           require('./routes/tls'));
app.use('/api/v1/analytics',     require('./routes/analytics'));
app.use('/api/v1/fleet',         require('./routes/fleet'));
app.use('/api/v1/dry-run',       require('./routes/dryRun'));
app.use('/api/v1/filter-groups', require('./routes/filterGroups'));
app.use('/api/v1/infoseciq',     require('./routes/infosecIq'));
app.use('/api/v1/phones',        require('./routes/phones'));
app.use('/api/v1/phones',        require('./routes/phoneChanges'));
app.use('/api/v1/chat',          require('./routes/chat'));
app.use('/api/v1/system',        require('./routes/systemHealth'));
app.use('/api/v1/internet-health', require('./routes/internetHealth'));
app.use('/api/v1/live-view',     require('./routes/liveView'));
app.use('/api/v1/vpn',           require('./routes/vpn'));
app.use('/api/v1/backup',        require('./routes/backup'));
app.use('/api/v1/security',      require('./routes/security'));
app.use('/api/v1/parent-report', require('./routes/parentReport'));
app.use('/api/v1/reports',       require('./routes/reports'));
app.use('/api/v1/classpulse',    require('./routes/classpulse'));
app.use('/api/v1/lost-mode',     require('./routes/lostMode'));
app.use('/api/v1/filter-bypass', require('./routes/filterBypass'));
app.use('/api/v1/kb',            require('./routes/knowledgeBase'));
app.use('/api/v1/network-tools', require('./routes/networkTools'));
app.use('/api/v1/lookup',        require('./routes/lookup'));
app.use('/api/v1/api-tokens',    require('./routes/apiTokens'));
app.use('/metrics',              require('./routes/metrics'));

// Health check — used by Docker, load balancers, and the HA node registry
const healthLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.get('/health', healthLimiter, async (req, res) => {
  const { pool } = require('./db');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', node: config.node.id, version: config.version });
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
  require('./services/acmeTls').syncCertFromDb();
});

module.exports = { app, io };
