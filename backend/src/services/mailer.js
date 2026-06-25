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

module.exports = { sendMail, sendSafetyAlert, sendFilterBypassAlert, getSmtpSettings };
