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

export default function PenaltyBox() {
  const queryClient = useQueryClient();

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
        Release to restore their normal policy.
      </p>
    </div>
  );
}
