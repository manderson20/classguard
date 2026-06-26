import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

function timeSince(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function AllowSiteModal({ entry, onClose }) {
  const [domain, setDomain] = useState('');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  const submit = useMutation({
    mutationFn: () => api.post(`/penalty-box/${entry.student_id}/allow-request`, { domain: domain.trim(), reason: reason.trim() || undefined }),
    onSuccess: () => setSubmitted(true),
    onError: (err) => setError(err?.response?.data?.error || 'Request failed'),
  });

  if (submitted) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 text-center">
          <div className="text-4xl mb-3">✅</div>
          <h2 className="text-lg font-semibold text-slate-900 mb-1">Request submitted</h2>
          <p className="text-sm text-slate-500 mb-5">
            An admin has been notified and will review the request for <strong>{domain}</strong>.
          </p>
          <button onClick={onClose} className="btn btn-primary w-full">Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-lg font-semibold text-slate-900">Request site access</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            For <strong>{entry.student_name || entry.student_email}</strong> — an admin will review this request.
          </p>
        </div>
        <div className="px-6 pb-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Domain or URL</label>
            <input
              type="text"
              placeholder="e.g. khanacademy.org"
              value={domain}
              onChange={e => setDomain(e.target.value)}
              className="input w-full"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Reason <span className="text-slate-400 font-normal">(optional)</span></label>
            <textarea
              rows={2}
              placeholder="Why does this student need access to this site?"
              value={reason}
              onChange={e => setReason(e.target.value)}
              className="input w-full resize-none"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="btn btn-secondary flex-1">Cancel</button>
            <button
              onClick={() => submit.mutate()}
              disabled={!domain.trim() || submit.isPending}
              className="btn btn-primary flex-1"
            >
              {submit.isPending ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PenaltyBox() {
  const queryClient = useQueryClient();
  const [allowModal, setAllowModal] = useState(null); // entry object or null

  const { data: entries = [], isLoading } = useQuery({
    queryKey:        ['penalty-box'],
    queryFn:         () => api.get('/penalty-box'),
    refetchInterval: 30_000,
  });

  const release = useMutation({
    mutationFn: (studentId) => api.delete(`/penalty-box/${studentId}`),
    onSuccess:  () => queryClient.invalidateQueries({ queryKey: ['penalty-box'] }),
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Penalty Box</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Students with restricted internet access
        </p>
      </div>

      {isLoading && (
        <div className="card p-4 animate-pulse space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-12 bg-slate-100 rounded" />)}
        </div>
      )}

      {!isLoading && entries.length === 0 && (
        <div className="card p-10 text-center text-slate-500">
          <div className="text-4xl mb-3">✅</div>
          <p className="font-medium">No students currently restricted</p>
        </div>
      )}

      {!isLoading && entries.length > 0 && (
        <div className="card divide-y divide-slate-100 overflow-hidden">
          {entries.map(entry => (
            <div key={entry.id} className="flex items-center gap-4 px-4 py-3">
              <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 text-sm">
                ⚠️
              </div>

              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-slate-900">
                  {entry.student_name || entry.student_email}
                </div>
                <div className="text-xs text-slate-500 truncate">
                  {entry.reason ? `Reason: ${entry.reason}` : 'No reason given'}
                  {' · '}Restricted {timeSince(entry.placed_at)}
                  {entry.placed_by_name && ` by ${entry.placed_by_name}`}
                </div>
              </div>

              {entry.expires_at && (
                <div className="text-xs text-amber-600 hidden sm:block flex-shrink-0">
                  Expires {new Date(entry.expires_at).toLocaleTimeString()}
                </div>
              )}

              <button
                onClick={() => setAllowModal(entry)}
                className="btn btn-sm btn-secondary flex-shrink-0"
              >
                Allow site…
              </button>

              <button
                onClick={() => release.mutate(entry.student_id)}
                disabled={release.isPending}
                className="btn btn-sm btn-secondary flex-shrink-0"
              >
                Release
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-slate-400 mt-4">
        Placing a student in the penalty box blocks all internet access on their device.
        Release to restore their normal policy. Use "Allow site…" to request a specific site be accessible while restricted.
      </p>

      {allowModal && (
        <AllowSiteModal
          entry={allowModal}
          onClose={() => setAllowModal(null)}
        />
      )}
    </div>
  );
}
