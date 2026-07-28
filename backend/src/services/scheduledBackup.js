// Scheduled encrypted config backups with count-based retention.
//
// Files land in BACKUP_DIR (a docker volume) on whichever node runs the cron
// jobs — i.e. the primary. They are node-local by design: a standby promoted
// to primary simply starts writing its own series. The UI download button is
// how copies get off-box; a backup that only lives on the server it's meant
// to resurrect is a convenience, not a DR plan, and the page says so.
//
// The encryption passphrase comes from settings.backup_passphrase. Storing it
// server-side is what makes unattended runs possible at all; it follows the
// same trust model as every other credential in settings (google_client_secret,
// ldap_bind_password, ...). The passphrase alone is useless without a file,
// and scheduled files carry env identity (JWT_SECRET), so file access —
// list/download/delete — is hardcoded superadmin-only in routes/backup.js.
const fs   = require('fs');
const path = require('path');
const { query }    = require('../db');
const configBackup = require('./configBackup');

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || '/app/backups');

// classguard-backup-20260728T041500Z.cgbk — no user input in names, and the
// strict pattern doubles as the traversal guard on download/delete.
const NAME_RE = /^classguard-backup-\d{8}T\d{6}Z\.cgbk$/;

const SETTING_KEYS = [
  'backup_schedule', 'backup_schedule_time', 'backup_schedule_day',
  'backup_retention_count', 'backup_passphrase',
];

async function getScheduleSettings() {
  const { rows } = await query(
    `SELECT key, value FROM settings WHERE key = ANY($1)`, [SETTING_KEYS]
  );
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    schedule:  ['daily', 'weekly'].includes(s.backup_schedule) ? s.backup_schedule : 'off',
    time:      /^\d{2}:\d{2}$/.test(s.backup_schedule_time || '') ? s.backup_schedule_time : '02:30',
    day:       /^[0-6]$/.test(s.backup_schedule_day || '') ? parseInt(s.backup_schedule_day, 10) : 0,
    retention: Math.max(1, parseInt(s.backup_retention_count, 10) || 14),
    passphrase: s.backup_passphrase || '',
  };
}

// Per-minute boundary check, same idiom as the bell-schedule auto-start:
// fire when the server-time HH:MM matches the configured slot. cron ticks
// once per minute so the equality can't double-fire within a slot.
async function maybeRun() {
  const s = await getScheduleSettings();
  if (s.schedule === 'off') return;

  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hhmm !== s.time) return;
  if (s.schedule === 'weekly' && now.getDay() !== s.day) return;

  if (!s.passphrase) {
    console.error('[backup] scheduled backup skipped — no backup passphrase set (Backup & Restore page)');
    return;
  }
  await runBackup(s);
}

async function runBackup(settings) {
  const s = settings || await getScheduleSettings();
  if (!s.passphrase) throw new Error('No backup passphrase is set');

  const started = Date.now();
  // Env identity always rides along: an unattended backup exists to rebuild
  // this server from nothing, and the superadmin-only download gate covers
  // the delegation concern the manual export path handles per-caller.
  const buffer = await configBackup.createBackup(s.passphrase, { includeEnvIdentity: true });

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const name  = `classguard-backup-${stamp}.cgbk`;
  const dest  = path.join(BACKUP_DIR, name);
  // tmp + rename so a crash mid-write can never leave a truncated .cgbk that
  // looks like a real backup in the list.
  fs.writeFileSync(dest + '.tmp', buffer);
  fs.renameSync(dest + '.tmp', dest);

  const pruned = pruneBackups(s.retention);
  console.log(`[backup] wrote ${name} (${buffer.length} bytes, ${Date.now() - started}ms)` +
    (pruned.length ? `, pruned ${pruned.join(', ')}` : ''));
  return { name, size: buffer.length, pruned };
}

// Keep the N newest scheduled files, delete the rest. Only files matching
// NAME_RE are ever considered — anything else in the volume is left alone.
function pruneBackups(retention) {
  const files = listBackupFiles();
  const excess = files.slice(retention);
  for (const f of excess) fs.unlinkSync(path.join(BACKUP_DIR, f.name));
  return excess.map(f => f.name);
}

// Newest first. Header fields (createdAt, version) are read from the file's
// cleartext header — the first few KB — not by loading whole backups.
function listBackupFiles() {
  let names;
  try {
    names = fs.readdirSync(BACKUP_DIR).filter(n => NAME_RE.test(n));
  } catch {
    return []; // volume not mounted / first run before any backup
  }
  const files = [];
  for (const name of names) {
    const full = path.join(BACKUP_DIR, name);
    try {
      const stat = fs.statSync(full);
      const entry = { name, size: stat.size, mtime: stat.mtime.toISOString() };
      try {
        const head = readHeader(full);
        entry.createdAt         = head.createdAt;
        entry.classguardVersion = head.classguardVersion;
        entry.tableCount        = head.tables?.length;
      } catch { /* corrupted/foreign file — still listed so it can be deleted */ }
      files.push(entry);
    } catch { /* raced a prune — skip */ }
  }
  return files.sort((a, b) => b.name.localeCompare(a.name));
}

// The cleartext header is a few KB (table names + row counts + file paths);
// 64 KB is comfortably past any real header without reading the ciphertext.
function readHeader(fullPath) {
  const fd = fs.openSync(fullPath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return configBackup.parseHeader(buf.subarray(0, read)).header;
  } finally {
    fs.closeSync(fd);
  }
}

function resolveBackupFile(name) {
  if (!NAME_RE.test(name)) return null;
  const full = path.join(BACKUP_DIR, name);
  return fs.existsSync(full) ? full : null;
}

function deleteBackup(name) {
  const full = resolveBackupFile(name);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}

module.exports = {
  BACKUP_DIR, maybeRun, runBackup, listBackupFiles, deleteBackup,
  resolveBackupFile, getScheduleSettings,
};
