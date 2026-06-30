import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../lib/api';

const DURATION_OPTIONS = [
  { value: 30,  label: '30 minutes' },
  { value: 60,  label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
];

function formatExpiry(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function formatTimeLeft(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'Expired';
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m remaining`;
  return `${m} min remaining`;
}

export default function DryRunPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'superadmin';
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['dry-run-state'],
    queryFn:  () => api.get('/dry-run'),
    refetchInterval: 15_000,
  });

  const [showModal, setShowModal] = useState(false);
  const [duration,  setDuration]  = useState(30);
  const [confirm,   setConfirm]   = useState('');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const [disabling, setDisabling] = useState(false);

  const active = data?.active === true;

  const handleEnable = async () => {
    if (confirm !== 'CONFIRM') {
      setError('Type CONFIRM (all caps) to proceed.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.post('/dry-run', { duration, confirmation: confirm });
      qc.invalidateQueries({ queryKey: ['dry-run-state'] });
      setShowModal(false);
      setConfirm('');
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to enable dry-run mode.');
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    setDisabling(true);
    try {
      await api.delete('/dry-run');
      qc.invalidateQueries({ queryKey: ['dry-run-state'] });
    } catch {
      // swallow — poll will clear on next tick
    } finally {
      setDisabling(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-slate-800 mb-1">Dry Run Mode</h1>
      <p className="text-sm text-slate-500 mb-6">
        Temporarily bypass all DNS filtering for troubleshooting. Queries still resolve through
        ClassGuard and are logged with action <code className="bg-slate-100 px-1 rounded">dry_run_blocked</code> to
        show what would have been blocked. Auto-expires at the chosen time.
      </p>

      {/* What gets bypassed */}
      <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-6">
        <p className="text-sm font-semibold text-orange-800 mb-2">When active, the following are all bypassed:</p>
        <ul className="list-disc list-inside text-sm text-orange-700 space-y-1">
          <li>Network blocklist (malware / adult / custom blocked sites)</li>
          <li>Content category filters</li>
          <li>Lesson mode (lesson-locked browsing)</li>
          <li>Penalty box (individual student lockdowns)</li>
          <li>Per-student and subnet policy restrictions</li>
        </ul>
        <p className="text-xs text-orange-600 mt-2">
          Local authoritative records and conditional forwarding zones are not affected.
          DHCP, VPN, and all other services are unaffected.
        </p>
      </div>

      {/* Current status */}
      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : active ? (
        <div className="bg-orange-100 border border-orange-300 rounded-lg p-5 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-semibold text-orange-800 text-base">Dry run is ACTIVE</p>
              <p className="text-sm text-orange-700 mt-1">
                Expires: {formatExpiry(data.expiresAt)}
                {data.expiresAt && (
                  <span className="ml-2 font-medium">({formatTimeLeft(data.expiresAt)})</span>
                )}
              </p>
              {data.enabledBy && (
                <p className="text-xs text-orange-600 mt-1">Enabled by {data.enabledBy}</p>
              )}
            </div>
            {isSuperAdmin && (
              <button
                className="bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold px-4 py-2 rounded disabled:opacity-60 flex-shrink-0"
                onClick={handleDisable}
                disabled={disabling}
              >
                {disabling ? 'Disabling…' : 'Disable Now'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-5 mb-6">
          <p className="font-semibold text-emerald-800">Filtering is active — all policies enforced normally</p>
          <p className="text-sm text-emerald-700 mt-1">Dry run mode is off.</p>
        </div>
      )}

      {/* Enable button — superadmin only */}
      {isSuperAdmin && !active && (
        <button
          className="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-5 py-2.5 rounded-lg text-sm"
          onClick={() => { setShowModal(true); setError(''); setConfirm(''); setDuration(30); }}
        >
          Enable Dry Run Mode
        </button>
      )}

      {!isSuperAdmin && (
        <p className="text-sm text-slate-400 italic">Only superadmins can enable or disable dry run mode.</p>
      )}

      {/* Confirmation modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
            <h2 className="text-lg font-bold text-slate-800 mb-1">Enable Dry Run Mode</h2>
            <p className="text-sm text-slate-500 mb-4">
              This will bypass all filtering for the chosen duration. All DNS queries will
              still resolve and be logged. Students can browse any site during this window.
            </p>

            <label className="block text-sm font-medium text-slate-700 mb-1">Duration</label>
            <select
              value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              {DURATION_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>

            <label className="block text-sm font-medium text-slate-700 mb-1">
              Type <code className="bg-slate-100 px-1 rounded font-mono">CONFIRM</code> to proceed
            </label>
            <input
              type="text"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleEnable()}
              placeholder="CONFIRM"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono mb-1 focus:outline-none focus:ring-2 focus:ring-orange-500"
              autoFocus
            />

            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

            <div className="flex justify-end gap-2 mt-4">
              <button
                className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 rounded"
                onClick={() => setShowModal(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-5 py-2 rounded-lg disabled:opacity-60"
                onClick={handleEnable}
                disabled={saving || confirm !== 'CONFIRM'}
              >
                {saving ? 'Enabling…' : 'Enable Dry Run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
