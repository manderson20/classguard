const dgram  = require('dgram');
const { pool } = require('../db');

const NTP_PORT  = 123;
const NTP_EPOCH = 2208988800; // seconds between 1900 and 1970

// ---------------------------------------------------------------------------
// Send one NTP client request and parse the response
// ---------------------------------------------------------------------------
function queryNtpServer(host, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const sent   = Date.now();

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timeout'));
    }, timeoutMs);

    // 48-byte NTP request: LI=0, VN=4, Mode=3 (client)
    const packet = Buffer.alloc(48, 0);
    packet[0] = 0x23;

    socket.once('message', (msg) => {
      clearTimeout(timer);
      const received = Date.now();
      socket.close();

      try {
        const stratum    = msg[1];
        const pollExp    = msg[2];

        // Transmit timestamp (bytes 40–47)
        const txSec  = msg.readUInt32BE(40) - NTP_EPOCH;
        const txFrac = msg.readUInt32BE(44);

        // Originate timestamp (bytes 24–31) — what we sent
        // Reference timestamp (bytes 16–23)
        const refSec = msg.readUInt32BE(16) - NTP_EPOCH;

        // Reference clock identifier (bytes 12–15)
        let refId;
        if (stratum <= 1) {
          // Stratum 0 or 1: ASCII identifier
          refId = msg.slice(12, 16).toString('ascii').replace(/\0/g, '');
        } else {
          // Stratum 2+: IPv4 address of reference
          refId = `${msg[12]}.${msg[13]}.${msg[14]}.${msg[15]}`;
        }

        const rtt      = received - sent;
        const offsetMs = (txSec * 1000 + txFrac / 4294967.296) - (sent + rtt / 2);

        resolve({
          address:      host,
          stratum,
          poll_interval: Math.pow(2, pollExp),
          offset_ms:    Math.round(offsetMs * 1000) / 1000,
          delay_ms:     Math.round(rtt * 100) / 100,
          jitter_ms:    0,  // single sample — no jitter calc
          reachable:    true,
          reference:    refId,
          checked_at:   new Date().toISOString(),
        });
      } catch (err) {
        reject(new Error(`Parse error: ${err.message}`));
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.send(packet, 0, 48, NTP_PORT, host);
  });
}

// ---------------------------------------------------------------------------
// Poll all active NTP servers and cache results in ntp_peer_status
// ---------------------------------------------------------------------------
async function pollAll() {
  const { rows: servers } = await pool.query(
    'SELECT * FROM ntp_servers WHERE is_active = true'
  );

  const results = await Promise.allSettled(
    servers.map(s => queryNtpServer(s.address))
  );

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    const r      = results[i];
    const status = r.status === 'fulfilled'
      ? r.value
      : { address: server.address, reachable: false, stratum: null, offset_ms: null,
          delay_ms: null, jitter_ms: null, reference: null, poll_interval: null };

    await pool.query(
      `INSERT INTO ntp_peer_status
         (server_id, address, stratum, offset_ms, delay_ms, jitter_ms, reachable, reference, poll_interval, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (server_id) DO UPDATE SET
         stratum = EXCLUDED.stratum, offset_ms = EXCLUDED.offset_ms,
         delay_ms = EXCLUDED.delay_ms, jitter_ms = EXCLUDED.jitter_ms,
         reachable = EXCLUDED.reachable, reference = EXCLUDED.reference,
         poll_interval = EXCLUDED.poll_interval, checked_at = NOW()`,
      [server.id, status.address, status.stratum, status.offset_ms,
       status.delay_ms, status.jitter_ms, status.reachable, status.reference, status.poll_interval]
    );
  }

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { address: servers[i].address, reachable: false, error: r.reason?.message }
  );
}

module.exports = { queryNtpServer, pollAll };
