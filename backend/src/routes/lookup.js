// GET /api/v1/lookup?ip=<ip-address> — external read-only endpoint for
// PrintOps (print.brookfieldr3.org) to resolve a printing client's IP to
// its MAC address. PrintOps sits on a different subnet than printing
// clients, so its own ARP table never has an entry for them; ClassGuard
// sits on the client subnets and already tracks DHCP leases, so it's the
// natural source. PrintOps then matches the MAC against its cached Mosyle
// device list to attribute the print job to a real person instead of
// whatever CUPS reports.
//
// Auth: single shared-secret token via X-ClassGuard-Token, checked against
// the api_tokens table (name='printops_lookup' — Integrations page > API
// Tokens) — same shared-secret pattern as the /metrics endpoint's
// X-Metrics-Token, and mirrors PrintOps' own X-Backend-Token
// service-to-service auth.
//
// "No active lease for this IP" is a routine, expected outcome — a
// meaningful fraction of client IPs won't currently have a lease (e.g. a
// laptop taken home) — not an error, so it's never logged as one.

const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const kea     = require('../services/kea');

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIpv4(ip) {
  const m = IPV4_RE.exec(ip);
  return !!m && m.slice(1).every(octet => Number(octet) <= 255);
}

async function lookupAuth(req, res, next) {
  const token = req.headers['x-classguard-token'];
  if (!token) return res.status(401).json({ detail: 'X-ClassGuard-Token header required' });

  try {
    const { rows } = await pool.query(
      `UPDATE api_tokens SET last_used_at = NOW()
       WHERE name = 'printops_lookup' AND is_active = true AND token = $1
       RETURNING id`,
      [token]
    );
    if (!rows.length) return res.status(401).json({ detail: 'Unauthorized' });
    next();
  } catch {
    res.status(500).json({ detail: 'Auth check failed' });
  }
}

router.get('/', lookupAuth, async (req, res) => {
  const { ip } = req.query;
  if (!ip || !isValidIpv4(ip)) {
    return res.status(400).json({ detail: 'Valid ip query parameter required' });
  }

  let lease;
  try {
    lease = await kea.getLease(ip);
  } catch (err) {
    console.error('[lookup] Kea request failed:', err.message);
    return res.status(502).json({ detail: 'Lease lookup unavailable' });
  }

  // state 0 = active/valid. No lease, or a declined/expired-reclaimed one,
  // both mean "no current IP->MAC mapping" — same routine 404.
  //
  // state alone isn't sufficient: a lease whose lifetime has elapsed keeps
  // state 0 until Kea's reclamation cycle runs, so also check cltt +
  // valid-lft against now — otherwise a reused/expired IP would be
  // attributed to the previous device's MAC instead of 404ing.
  const expired = lease &&
    Number.isFinite(lease.cltt) && Number.isFinite(lease['valid-lft']) &&
    (lease.cltt + lease['valid-lft']) * 1000 <= Date.now();
  const mac = lease && lease.state === 0 && !expired ? lease['hw-address'] : null;
  if (!mac) return res.status(404).json({ detail: 'No active lease for this IP' });

  res.json({ mac_address: mac });
});

module.exports = router;
