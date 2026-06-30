require('dotenv').config();
const DNS                    = require('dns2');
const express                = require('express');
const { resolveQuery, buildResponse } = require('./resolver');
const { dohHandler }         = require('./doh');
const { getCount }           = require('./blocklistLoader');
const config                 = require('./config');
const redis                  = require('./redis');

// ---------------------------------------------------------------------------
// DNS Server (UDP + TCP on port 53)
// ---------------------------------------------------------------------------
const dnsServer = DNS.createServer({
  udp: true,
  tcp: true,
  handle: async (request, send, rinfo) => {
    const [question] = request.questions;

    if (!question) {
      const response = DNS.Packet.createResponseFromRequest(request);
      response.header.rcode = DNS.Packet.RCODE.FORMERR;
      return send(response);
    }

    try {
      // dns2's TCP server hands the handler the raw net.Socket as `rinfo`,
      // not a {address, port} dict like UDP gets — rinfo.address is then
      // Socket.prototype.address (a function returning the *local* bound
      // address), not the peer's IP. Socket.remoteAddress is the actual
      // client IP for that case. Confirmed live: TCP-retried queries (large
      // responses that exceeded the UDP truncation threshold) were logging
      // a stringified function body as sourceIp, which Postgres's inet
      // column rejected — and since that one bad row poisons the whole
      // unnest() batch insert, it silently blocked the entire DNS log drain
      // (everyone's queries, not just the TCP ones) from that point on.
      const sourceIp = typeof rinfo.address === 'function' ? rinfo.remoteAddress : rinfo.address;
      const result   = await resolveQuery(question.name, question.type, sourceIp);
      const response = await buildResponse(request, result);
      send(response);
    } catch (err) {
      console.error('[dns] handler error:', err.message);
      const response = DNS.Packet.createResponseFromRequest(request);
      response.header.rcode = DNS.Packet.RCODE.SERVFAIL;
      send(response);
    }
  },
});

dnsServer.on('listening', () =>
  console.log(`[dns] listening on UDP+TCP port ${config.dns.port}`)
);
dnsServer.on('error', (err) =>
  console.error('[dns] server error:', err.message)
);

dnsServer.listen({
  udp: { port: config.dns.port, address: '0.0.0.0' },
  tcp: { port: config.dns.port, address: '0.0.0.0' },
});

// ---------------------------------------------------------------------------
// HTTP Server (port 3053) — health, reload, DoH
// ---------------------------------------------------------------------------
const app = express();

// Raw body parser for DoH POST (must come before express.json)
app.use('/dns-query', express.raw({ type: 'application/dns-message', limit: '16kb' }));
app.use(express.json());

// Health check — inline limiter: 120 req/min per IP (no extra dependency)
const _healthCalls = new Map();
function healthLimiter(req, res, next) {
  const ip  = req.ip || req.socket.remoteAddress || '';
  const now = Date.now();
  const rec = _healthCalls.get(ip) || { count: 0, start: now };
  if (now - rec.start > 60_000) { rec.count = 0; rec.start = now; }
  if (++rec.count > 120) return res.status(429).json({ error: 'Too Many Requests' });
  _healthCalls.set(ip, rec);
  next();
}
app.get('/health', healthLimiter, async (req, res) => {
  try {
    await redis.ping();
    const blocklistCount = await getCount();
    res.json({
      status:         'ok',
      dns:            `listening on :${config.dns.port}`,
      blocklist:      blocklistCount,
      upstreamPrimary: config.dns.upstreamPrimary,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', detail: err.message });
  }
});

// Force a blocklist reload notification (backend calls this after a sync)
app.post('/reload', (req, res) => {
  // The blocklist is read live from Redis on each query via pipeline,
  // so there's nothing to reload in memory. This endpoint exists for
  // future in-process caching and for monitoring/scripting convenience.
  console.log('[dns] reload requested');
  res.json({ status: 'ok', message: 'Blocklist reads live from Redis — no action needed' });
});

// DNS over HTTPS (RFC 8484)
app.get('/dns-query',  dohHandler);
app.post('/dns-query', dohHandler);

app.listen(config.http.port, () =>
  console.log(`[dns-http] listening on port ${config.http.port}`)
);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const shutdown = async (signal) => {
  console.log(`[dns] ${signal} — shutting down`);
  dnsServer.close();
  await redis.quit().catch(() => {});
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

console.log('[dns] ClassGuard DNS engine starting...');
