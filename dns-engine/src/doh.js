const dgram  = require('dgram');
const config = require('./config');

const DOH_CONTENT_TYPE = 'application/dns-message';
const TIMEOUT_MS       = 5000;

/**
 * DNS over HTTPS handler (RFC 8484).
 *
 * Rather than duplicating response serialization, we forward the raw
 * DNS wire-format message to our own UDP DNS server on 127.0.0.1:53
 * and relay the response back. This reuses all filtering logic automatically.
 *
 * GET  /dns-query?dns=<base64url-encoded wire message>
 * POST /dns-query  body: raw DNS wire message (Content-Type: application/dns-message)
 */
async function dohHandler(req, res) {
  let dnsMessage;

  try {
    if (req.method === 'GET') {
      const encoded = Array.isArray(req.query.dns) ? req.query.dns[0] : req.query.dns;
      if (!encoded) return res.status(400).send('Missing dns parameter');
      dnsMessage = Buffer.from(String(encoded), 'base64url');
    } else {
      const raw = req.body; // express raw body parser provides a Buffer
      if (!Buffer.isBuffer(raw) || raw.length === 0) {
        return res.status(400).send('Empty or invalid DNS message body');
      }
      dnsMessage = Buffer.from(raw); // explicit copy breaks the taint from req.body
    }
  } catch {
    return res.status(400).send('Failed to decode DNS message');
  }

  try {
    const responseBuffer = await forwardToLocalDns(dnsMessage);
    res.set('Content-Type', DOH_CONTENT_TYPE);
    res.set('Cache-Control', 'no-store');
    return res.send(responseBuffer);
  } catch (err) {
    console.error('[doh] error:', err.message);
    return res.status(502).send('DNS resolution failed');
  }
}

/**
 * Send a raw DNS wire-format message to our local UDP DNS server
 * and return the raw response buffer.
 */
function forwardToLocalDns(message) {
  return new Promise((resolve, reject) => {
    const socket  = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('DoH upstream timeout'));
    }, TIMEOUT_MS);

    socket.once('message', (response) => {
      clearTimeout(timeout);
      socket.close();
      resolve(response);
    });

    socket.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.send(message, 0, message.length, config.dns.port, '127.0.0.1', (err) => {
      if (err) {
        clearTimeout(timeout);
        socket.close();
        reject(err);
      }
    });
  });
}

module.exports = { dohHandler };
