import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';

const ROLES = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function ScheduledSection() {
  const [data, setData]   = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy]   = useState(false);
  const [saved, setSaved] = useState(false);

  // Editable schedule form state
  const [schedule, setSchedule]   = useState('off');
  const [time, setTime]           = useState('02:30');
  const [day, setDay]             = useState(0);
  const [retention, setRetention] = useState(14);
  const [passphrase, setPassphrase] = useState('');

  const token = localStorage.getItem('cg_token');
  const authed = useCallback((path, opts = {}) =>
    fetch(`/api/v1${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } }), [token]);

  const load = useCallback(async () => {
    try {
      const res  = await authed('/backup/scheduled');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load');
      setData(json);
      setSchedule(json.schedule.schedule);
      setTime(json.schedule.time);
      setDay(json.schedule.day);
      setRetention(json.schedule.retention);
    } catch (e) {
      setError(e.message);
    }
  }, [authed]);

  useEffect(() => { load(); }, [load]);

  async function saveConfig() {
    setBusy(true); setError(''); setSaved(false);
    try {
      const body = {
        backup_schedule: schedule,
        backup_schedule_time: time,
        backup_schedule_day: String(day),
        backup_retention_count: String(retention),
      };
      // Blank means "keep the stored passphrase" — never overwrite with ''.
      if (passphrase) body.backup_passphrase = passphrase;
      const res = await authed('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to save');
      setPassphrase('');
      setSaved(true);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true); setError('');
    try {
      const res  = await authed('/backup/scheduled/run', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Backup failed');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function download(name) {
    setError('');
    try {
      const res = await authed(`/backup/scheduled/${name}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(name) {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
    setError('');
    try {
      const res = await authed(`/backup/scheduled/${name}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Delete failed');
      }
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-1">Scheduled Backups</h2>
      <p className="text-xs text-slate-500 mb-4">
        Automatic encrypted backups, written on the primary server and kept to the retention count below. These
        files include the server identity keys, so access is superadmin-only. They live on the server itself —
        download copies somewhere safe regularly; a backup that only exists on the machine it's meant to rebuild
        won't survive losing that machine.
      </p>

      {data && !data.passphraseSet && schedule !== 'off' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 mb-4">
          No backup passphrase is set — scheduled backups will be skipped until you set one below.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 max-w-lg mb-3">
        <div>
          <label className="label">Schedule</label>
          <select className="input text-sm" value={schedule} onChange={e => setSchedule(e.target.value)}>
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        <div>
          <label className="label">Time (server time)</label>
          <input type="time" className="input text-sm" value={time} onChange={e => setTime(e.target.value)} />
        </div>
        {schedule === 'weekly' && (
          <div>
            <label className="label">Day</label>
            <select className="input text-sm" value={day} onChange={e => setDay(Number(e.target.value))}>
              {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="label">Keep most recent</label>
          <input
            type="number" min="1" max="365" className="input text-sm"
            value={retention}
            onChange={e => setRetention(Math.max(1, parseInt(e.target.value, 10) || 1))}
          />
        </div>
        <div className="col-span-2">
          <label className="label">Backup passphrase</label>
          <input
            type="password" className="input text-sm"
            placeholder={data?.passphraseSet ? 'Set — leave blank to keep' : 'Required for scheduled backups'}
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
          />
          {passphrase.length > 0 && passphrase.length < 8 && (
            <p className="text-xs text-red-600 mt-1">At least 8 characters</p>
          )}
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          className="btn-primary text-sm"
          onClick={saveConfig}
          disabled={busy || (passphrase.length > 0 && passphrase.length < 8)}
        >
          Save Schedule
        </button>
        <button
          className="btn-secondary text-sm"
          onClick={runNow}
          disabled={busy || !data?.passphraseSet}
          title={data?.passphraseSet ? '' : 'Set a passphrase first'}
        >
          {busy ? 'Working…' : 'Back Up Now'}
        </button>
        {saved && <span className="text-xs text-green-600 self-center">Saved.</span>}
      </div>

      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      {data?.files?.length > 0 ? (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="py-1.5 pr-3">File</th>
              <th className="py-1.5 pr-3">Created</th>
              <th className="py-1.5 pr-3">Size</th>
              <th className="py-1.5 pr-3">Version</th>
              <th className="py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {data.files.map(f => (
              <tr key={f.name} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 font-mono">{f.name}</td>
                <td className="py-1.5 pr-3">{f.createdAt ? new Date(f.createdAt).toLocaleString() : '—'}</td>
                <td className="py-1.5 pr-3">{fmtSize(f.size)}</td>
                <td className="py-1.5 pr-3">{f.classguardVersion || '—'}</td>
                <td className="py-1.5 text-right whitespace-nowrap">
                  <button className="text-brand-600 hover:underline mr-3" onClick={() => download(f.name)}>Download</button>
                  <button className="text-red-600 hover:underline" onClick={() => remove(f.name)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        data && <p className="text-xs text-slate-400">No scheduled backups yet.</p>
      )}
    </div>
  );
}

function ExportSection() {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const canExport = passphrase.length >= 8 && confirm === passphrase && !busy;

  async function doExport() {
    setBusy(true);
    setError('');
    setDone(false);
    try {
      const token = localStorage.getItem('cg_token');
      const res = await fetch('/api/v1/backup/export', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `classguard-backup-${new Date().toISOString().slice(0, 10)}.cgbk`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDone(true);
      setPassphrase('');
      setConfirm('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-1">Export Backup</h2>
      <p className="text-xs text-slate-500 mb-4">
        Downloads an encrypted file with this district's configuration — policies, settings, roster, network/DHCP/
        RADIUS/phone config, integrations, etc. — plus the Google LDAP client certificate files and (for superadmin
        exports) this server's identity keys, so a restore onto new hardware is complete. Deliberately excludes
        activity history (DNS logs, browser history, chat, audit trails) and cluster topology. Choose a passphrase
        you'll remember — there is no way to recover this file without it.
      </p>
      <div className="space-y-3 max-w-sm">
        <div>
          <label className="label">Passphrase</label>
          <input
            type="password"
            className="input text-sm"
            placeholder="At least 8 characters"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Confirm passphrase</label>
          <input
            type="password"
            className="input text-sm"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
          />
          {mismatch && <p className="text-xs text-red-600 mt-1">Passphrases don't match</p>}
        </div>
        <button className="btn-primary text-sm" onClick={doExport} disabled={!canExport}>
          {busy ? 'Building backup…' : 'Download Backup'}
        </button>
        {done && <p className="text-xs text-green-600">Downloaded — store this somewhere safe.</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

function RestoreSection() {
  const [file, setFile]   = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [passphrase, setPassphrase]   = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  function reset() {
    setFile(null); setPreview(null); setConfirmText(''); setPassphrase('');
    setError(''); setResult(null);
  }

  async function handleFile(f) {
    reset();
    setFile(f);
    setBusy(true);
    try {
      const token = localStorage.getItem('cg_token');
      const form  = new FormData();
      form.append('file', f);
      const res = await fetch('/api/v1/backup/preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not read this file');
      setPreview(data);
    } catch (e) {
      setError(e.message);
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function doRestore() {
    setBusy(true);
    setError('');
    try {
      const token = localStorage.getItem('cg_token');
      const form  = new FormData();
      form.append('file', file);
      form.append('passphrase', passphrase);
      const res = await fetch('/api/v1/backup/restore', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Restore failed');
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const totalRows = preview ? Object.values(preview.rowCounts || {}).reduce((a, b) => a + b, 0) : 0;
  const canRestore = preview && confirmText === 'RESTORE' && passphrase.length > 0 && !busy;

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-1">Restore Backup</h2>
      <p className="text-xs text-slate-500 mb-4">
        Intended for a freshly-installed, empty server — restoring deletes then re-inserts every table the backup
        covers. If this server already has activity history (DNS logs, browser history, etc.) referencing existing
        users or records, restore will fail with a foreign-key error rather than silently destroying that history.
        This is by design, not a bug to work around.
      </p>

      {!result && (
        <div className="max-w-md">
          <input
            type="file"
            accept=".cgbk"
            className="text-sm"
            onChange={e => e.target.files[0] && handleFile(e.target.files[0])}
          />

          {busy && !preview && <p className="text-xs text-slate-400 mt-2">Reading file…</p>}

          {preview && (
            <div className="mt-4 space-y-3">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
                <p><strong>Created:</strong> {new Date(preview.createdAt).toLocaleString()}</p>
                <p><strong>From ClassGuard version:</strong> {preview.classguardVersion} (node {preview.nodeId})</p>
                <p><strong>Tables:</strong> {preview.tables.length} · <strong>Total rows:</strong> {totalRows.toLocaleString()}</p>
                {preview.files?.length > 0 && (
                  <p><strong>Files:</strong> {preview.files.join(', ')}</p>
                )}
                {preview.envKeys?.length > 0 && (
                  <p><strong>Server identity keys:</strong> {preview.envKeys.join(', ')} (shown after restore)</p>
                )}
              </div>

              <div>
                <label className="label">Type RESTORE to confirm you want to overwrite this server's configuration</label>
                <input
                  className="input text-sm font-mono"
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  placeholder="RESTORE"
                />
              </div>
              <div>
                <label className="label">Backup passphrase</label>
                <input
                  type="password"
                  className="input text-sm"
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <button className="btn-primary text-sm bg-red-600 hover:bg-red-700" onClick={doRestore} disabled={!canRestore}>
                  {busy ? 'Restoring…' : 'Restore Now'}
                </button>
                <button className="btn-secondary text-sm" onClick={reset} disabled={busy}>Cancel</button>
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        </div>
      )}

      {result && (
        <div className="max-w-md">
          <p className="text-sm text-green-700 font-medium mb-2">
            Restored {result.restoredTables.length} tables successfully.
          </p>
          {result.skippedTables.length > 0 && (
            <p className="text-xs text-slate-500 mb-2">
              Skipped (don't exist on this server's current schema): {result.skippedTables.join(', ')}
            </p>
          )}
          {result.restoredFiles?.length > 0 && (
            <p className="text-xs text-slate-500 mb-2">
              Restored files: {result.restoredFiles.join(', ')}
            </p>
          )}
          {result.envIdentity && Object.keys(result.envIdentity).length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3">
              <p className="text-xs text-amber-800 mb-2">
                <strong>One manual step:</strong> this backup carries the original server's identity keys — apply
                them so existing logins stay valid and deployed Chrome extensions keep trusting this server. Run
                this in your ClassGuard directory on the host:
              </p>
              {/* Replace-or-append per key: a fresh install's .env may not have the
                  line at all (install.sh doesn't write EXTENSION_SIGNING_KEY), and a
                  replace-only sed would silently drop that key. Then force-recreate —
                  NOT `compose restart`, which documentedly does not re-read env_file —
                  exactly the services that consume the changed keys. */}
              <pre className="text-[11px] font-mono bg-white border border-amber-200 rounded p-2 overflow-x-auto select-all">
{Object.entries(result.envIdentity)
  .map(([k, v]) => `grep -q "^${k}=" .env && sed -i "s#^${k}=.*#${k}=${v}#" .env || echo "${k}=${v}" >> .env`)
  .join('\n')
  + `\ndocker compose up -d --force-recreate ${['api', ...(result.envIdentity.EXTENSION_SIGNING_KEY ? ['extension-builder'] : [])].join(' ')}`}
              </pre>
            </div>
          )}
          <p className="text-xs text-slate-500 mb-3">
            If the domain/IP for this server is different from where the backup was taken, update DNS and re-issue
            a TLS certificate if needed (Settings → TLS). A restart of the API container is recommended so caches
            reflect the restored data immediately rather than waiting for their normal TTL. On a new server, also
            re-pair any HA standby and let the device/category syncs run — synced datasets aren't in the backup by
            design and rebuild themselves.
          </p>
          <button className="btn-secondary text-sm" onClick={reset}>Restore another file</button>
        </div>
      )}
    </div>
  );
}

export default function BackupPage() {
  const { user } = useAuth();
  const isSuperAdmin = (ROLES[user?.role] ?? 0) >= ROLES.superadmin;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Backup & Restore</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Move this district's configuration to new hardware, or keep an encrypted copy somewhere safe.
        </p>
      </div>

      <ExportSection />
      {isSuperAdmin && <ScheduledSection />}
      {isSuperAdmin ? (
        <RestoreSection />
      ) : (
        <div className="card p-5 text-sm text-slate-500">
          Restore is superadmin-only — ask a superadmin if you need to restore a backup onto this server.
        </div>
      )}
    </div>
  );
}
