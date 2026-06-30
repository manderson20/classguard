const nodemailer = require('nodemailer');
const { query } = require('../db');

// SMTP credentials live in the settings table (DB-backed, UI-editable),
// never .env — same convention as every other integration in this project.
async function getSmtpSettings() {
  const { rows } = await query(
    `SELECT key, value FROM settings WHERE key IN
     ('smtp_host','smtp_port','smtp_secure','smtp_user','smtp_password','smtp_from','safety_alert_emails')`
  );
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function sendMail({ to, subject, text, html }) {
  const cfg = await getSmtpSettings();
  if (!cfg.smtp_host) return { sent: false, reason: 'SMTP not configured' };

  const transport = nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   parseInt(cfg.smtp_port, 10) || 587,
    secure: cfg.smtp_secure === 'true',
    auth:   cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_password } : undefined,
  });

  await transport.sendMail({
    from: cfg.smtp_from || cfg.smtp_user,
    to,
    subject,
    text,
    html,
  });
  return { sent: true };
}

async function sendSafetyAlert({ studentName, category, riskScore, url, screenshotId }) {
  const cfg = await getSmtpSettings();
  const recipients = (cfg.safety_alert_emails || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length || !cfg.smtp_host) return { sent: false, reason: 'no recipients or SMTP not configured' };

  const subject = `[ClassGuard] Urgent safety alert — ${category} (risk ${riskScore})`;
  const text =
    `A high-severity safety event was just captured for ${studentName || 'a student'}.\n\n` +
    `Category: ${category}\nRisk score: ${riskScore}/100\nPage: ${url}\n\n` +
    `Review it now in ClassGuard under Screenshots (incident ${screenshotId}).`;

  return sendMail({ to: recipients.join(','), subject, text });
}

async function sendFilterBypassAlert({ studentName, deviceName, ipAddress }) {
  const cfg = await getSmtpSettings();
  const recipients = (cfg.safety_alert_emails || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length || !cfg.smtp_host) return { sent: false, reason: 'no recipients or SMTP not configured' };

  const subject = `[ClassGuard] Possible filter bypass — ${studentName || 'a student'}`;
  const text =
    `${studentName || 'A student'}'s Chromebook has been connected to school WiFi for several minutes ` +
    `but has generated no web traffic through ClassGuard's filter (IP ${ipAddress}, device ${deviceName || 'unknown'}).\n\n` +
    `This usually means the filter has been circumvented — a different DNS server, a VPN, or similar. ` +
    `Review it now in ClassGuard under Filter Bypass Alerts.`;

  return sendMail({ to: recipients.join(','), subject, text });
}

// Fleet gap alert — IT infrastructure, superadmins only, never the safety list.
// gaps: array from fleetSync.getGaps() filtered to missingFrom=['snipeit'].
async function sendFleetGapAlert(gaps) {
  const { rows: admins } = await query(`SELECT email FROM users WHERE role = 'superadmin'`);
  const recipients = admins.map(a => a.email).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'no superadmin recipients' };

  const cfg = await getSmtpSettings();
  if (!cfg.smtp_host) return { sent: false, reason: 'SMTP not configured' };

  const bySource = {};
  for (const g of gaps) {
    const src = (g.presentIn || []).filter(s => s !== 'snipeit').join(', ') || 'unknown';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(g);
  }

  const lines = [`${gaps.length} device(s) are in your MDM(s) but have no matching Snipe-IT asset:\n`];
  for (const [src, devs] of Object.entries(bySource)) {
    lines.push(`${src.toUpperCase()} (${devs.length}):`);
    const shown = devs.slice(0, 50);
    for (const d of shown) {
      lines.push(`  • ${d.serial}  ${d.deviceName || ''}  ${d.deviceModel || ''}  ${d.osType || ''}`);
    }
    if (devs.length > 50) lines.push(`  …and ${devs.length - 50} more`);
    lines.push('');
  }
  lines.push('See Fleet → Cross-Sync in ClassGuard for the full list and to run a sync.');

  const subject = `[ClassGuard] ${gaps.length} device(s) missing from Snipe-IT inventory`;
  return sendMail({ to: recipients.join(','), subject, text: lines.join('\n') });
}

module.exports = { sendMail, sendSafetyAlert, sendFilterBypassAlert, sendFleetGapAlert, getSmtpSettings };
