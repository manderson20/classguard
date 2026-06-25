// Detects a student's Chromebook being on school WiFi (confirmed via the
// UniFi network_clients integration, independent of the Chrome extension)
// while generating zero DNS queries through ClassGuard's own resolver --
// the signature of a student having switched DNS servers, tunneled, or
// otherwise routed around the filter entirely. DNS attribution in
// dns-engine/src/resolver.js is by source IP, not by anything the
// extension reports, so "zero rows for this IP" is a real signal even if
// the extension itself has been disabled.
//
// Scope and known limitations, deliberately:
//   - ChromeOS only (google_admin source) -- this is "Chromebook" filter
//     bypass detection specifically, not a general device-offline check.
//     Servers, network gear, and anything without a Google Admin record
//     never enter the candidate list at all.
//   - Excludes any assigned_email that maps to MORE than one device.
//     A real 1:1 student assignment is always exactly one Chromebook;
//     enrollment/kiosk/cart/fleet-management accounts show up as the
//     same email on dozens or thousands of devices (verified live: one
//     enrollment account had 1,729 devices) and would otherwise look
//     like a permanently-bypassing "student" forever, since kiosks
//     never generate normal browsing traffic to begin with.
//   - Only flags accounts with role = 'student' in our own users table --
//     staff Chromebooks aren't this feature's concern and may legitimately
//     have different network/VPN arrangements.
//   - Only runs during configured active hours (default weekdays
//     7am-4pm) -- a Chromebook idle overnight or over a weekend, still
//     associated to WiFi but generating no traffic, is normal, not a
//     bypass. No per-student bell-schedule awareness (period-level
//     granularity) since no real period data exists yet to drive that;
//     this is a simple global window instead.
//   - A device NOT currently on school WiFi at all (gone home, off
//     network) never enters the candidate list -- there is no way to
//     observe a bypass on a network we never see traffic from in the
//     first place, so it's correctly just not checked, not flagged.
//   - Requires two consecutive detections (~one scheduler interval apart)
//     before actually alerting -- a device that just associated to WiFi
//     and hasn't had time to generate any traffic yet would otherwise
//     look identical to one that's bypassing the filter.
const { pool, query } = require('../db');
const { getUnifiedDevices } = require('./deviceConsolidation');
const { sendFilterBypassAlert } = require('./mailer');
const events = require('../events');

const DNS_TRAFFIC_WINDOW_MINUTES = 20;

async function hasRecentDnsTraffic(ip) {
  if (!ip) return true; // no IP to check against -- don't flag on missing data
  const { rows } = await query(
    `SELECT EXISTS(SELECT 1 FROM dns_logs WHERE source_ip = $1 AND queried_at >= NOW() - INTERVAL '${DNS_TRAFFIC_WINDOW_MINUTES} minutes') AS found`,
    [ip]
  );
  return rows[0].found;
}

async function isWithinActiveHours() {
  const { rows } = await pool.query(
    `SELECT value FROM settings WHERE key IN ('filter_bypass_active_start', 'filter_bypass_active_end', 'filter_bypass_active_days')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const start = cfg.filter_bypass_active_start || '07:00';
  const end   = cfg.filter_bypass_active_end   || '16:00';
  const days  = (cfg.filter_bypass_active_days || '1,2,3,4,5').split(',').map(Number);

  const now = new Date();
  if (!days.includes(now.getDay())) return false;
  const hm = now.toTimeString().slice(0, 5);
  return hm >= start && hm <= end;
}

async function getStudentDevices(unified) {
  const emailCounts = new Map();
  for (const d of unified) {
    if (d.assignedEmail) emailCounts.set(d.assignedEmail, (emailCounts.get(d.assignedEmail) || 0) + 1);
  }

  const oneToOneEmails = unified
    .filter(d => d.assignedEmail && emailCounts.get(d.assignedEmail) === 1)
    .map(d => d.assignedEmail);
  if (!oneToOneEmails.length) return new Set();

  const { rows } = await pool.query(
    `SELECT email FROM users WHERE email = ANY($1) AND role = 'student'`,
    [oneToOneEmails]
  );
  return new Set(rows.map(r => r.email));
}

async function runDetection() {
  if (!(await isWithinActiveHours())) return { checked: 0, newAlerts: 0, skipped: 'outside active hours' };

  const unified = await getUnifiedDevices();
  const studentEmails = await getStudentDevices(unified);
  const candidates = unified.filter(d =>
    d.network?.status === 'online' &&
    d.network?.ip &&
    d.assignedEmail &&
    studentEmails.has(d.assignedEmail) &&
    d.sources.some(s => s.source === 'google_admin') // Chromebook specifically
  );

  let newAlerts = 0;
  for (const device of candidates) {
    const traffic = await hasRecentDnsTraffic(device.network.ip);
    const { rows: [existing] } = await pool.query(
      `SELECT * FROM filter_bypass_alerts WHERE device_key = $1 AND status IN ('pending','open') ORDER BY first_detected_at DESC LIMIT 1`,
      [device.key]
    );

    if (!traffic) {
      if (!existing) {
        await pool.query(
          `INSERT INTO filter_bypass_alerts (student_id, device_key, mac, last_ip, status, detail)
           VALUES ((SELECT id FROM users WHERE email = $1), $2, $3, $4, 'pending', $5)`,
          [device.assignedEmail, device.key, device.network.mac, device.network.ip,
           JSON.stringify({ deviceModel: device.deviceModel, apName: device.network.apName, ssid: device.network.ssid })]
        );
      } else if (existing.status === 'pending' && existing.first_detected_at <= new Date(Date.now() - 14 * 60_000)) {
        await pool.query(
          `UPDATE filter_bypass_alerts SET status = 'open', confirmed_at = NOW(), last_checked_at = NOW(), last_ip = $2 WHERE id = $1`,
          [existing.id, device.network.ip]
        );
        newAlerts++;

        const { rows: [student] } = await pool.query(`SELECT full_name FROM users WHERE email = $1`, [device.assignedEmail]);
        sendFilterBypassAlert({
          studentName: student?.full_name || device.assignedEmail,
          deviceName: device.deviceModel || device.serialNumber,
          ipAddress: device.network.ip,
        }).catch(err => console.error('[filter-bypass/email]', err.message));

        events.emit('safety:filter_bypass', {
          studentName: student?.full_name || device.assignedEmail,
          deviceModel: device.deviceModel,
          serialNumber: device.serialNumber,
          ipAddress: device.network.ip,
          detected_at: new Date().toISOString(),
        });
      } else {
        await pool.query(`UPDATE filter_bypass_alerts SET last_checked_at = NOW(), last_ip = $2 WHERE id = $1`, [existing.id, device.network.ip]);
      }
    } else if (existing) {
      // Traffic resumed -- whatever caused the gap is no longer happening.
      await pool.query(`UPDATE filter_bypass_alerts SET status = 'resolved', resolved_at = NOW() WHERE id = $1`, [existing.id]);
    }
  }

  return { checked: candidates.length, newAlerts };
}

module.exports = { runDetection };
