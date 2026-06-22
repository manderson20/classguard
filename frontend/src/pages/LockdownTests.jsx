import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

function timeSince(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function timeRemaining(endsAt) {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'ending…';
  const m = Math.ceil(ms / 60_000);
  return `${m}m left`;
}

export default function LockdownTests() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';

  const { data: sessions = [], isLoading } = useQuery({
    queryKey:        ['lockdown-active'],
    queryFn:         () => api.get('/lockdown/active'),
    refetchInterval: 10_000,
  });

  const endSession = useMutation({
    mutationFn: (id) => api.delete(`/lockdown/${id}`),
    onSuccess:  () => queryClient.invalidateQueries({ queryKey: ['lockdown-active'] }),
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Lockdown Tests</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          {isAdmin
            ? 'Every student currently locked into a test, district-wide — use this to get a student out if a lockdown gets stuck.'
            : 'Students currently locked into a test from your classes.'}
        </p>
      </div>

      {isLoading && (
        <div className="card p-4 animate-pulse space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-12 bg-slate-100 rounded" />)}
        </div>
      )}

      {!isLoading && sessions.length === 0 && (
        <div className="card p-10 text-center text-slate-500">
          <div className="text-4xl mb-3">🔓</div>
          <p className="font-medium">No active lockdown tests right now</p>
        </div>
      )}

      {!isLoading && sessions.length > 0 && (
        <div className="card divide-y divide-slate-100 overflow-hidden">
          {sessions.map(s => {
            const remaining = timeRemaining(s.ends_at);
            const eventCount = parseInt(s.event_count, 10) || 0;
            return (
              <div key={s.id} className="flex items-center gap-4 px-4 py-3">
                <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 text-sm">
                  🔒
                </div>

                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-slate-900">
                    {s.student_name || s.student_email}
                    {isAdmin && <span className="text-slate-400 font-normal"> · {s.teacher_name}</span>}
                  </div>
                  <div className="text-xs text-slate-500 truncate">
                    {s.target_url}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    Started {timeSince(s.started_at)}
                    {remaining && <span className="text-amber-600"> · {remaining}</span>}
                    {eventCount > 0 && (
                      <span className="text-red-500 font-medium"> · {eventCount} escape attempt{eventCount > 1 ? 's' : ''}</span>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => endSession.mutate(s.id)}
                  disabled={endSession.isPending}
                  className="btn btn-sm btn-secondary flex-shrink-0"
                >
                  End Lockdown
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-slate-400 mt-4">
        This is a soft lock — a browser extension can pin a student to the test page and close stray
        tabs/windows, but it can't block switching to another application at the OS level. Use this page
        to release a student if a lockdown gets stuck or needs to end early.
      </p>
    </div>
  );
}
