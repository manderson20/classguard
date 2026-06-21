import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '../../lib/api';
import Avatar from '../../components/Avatar';

const ACTION_COLORS = {
  allowed: 'text-green-600',
  blocked: 'text-red-600',
  unknown: 'text-slate-400',
};

export default function UserDetail() {
  const { userId } = useParams();

  const { data: user, isLoading: uLoading } = useQuery({
    queryKey: ['user', userId],
    queryFn:  () => api.get(`/users/${userId}`),
  });

  const { data: policy } = useQuery({
    queryKey: ['user-policy', userId],
    queryFn:  () => api.get(`/users/${userId}/effective-policy`),
  });

  const { data: logs = [] } = useQuery({
    queryKey: ['user-dns-logs', userId],
    queryFn:  () => {
      const from = new Date(Date.now() - 86400_000).toISOString();
      return api.get(`/dns/logs?student_id=${userId}&from=${from}&limit=50`).then(r => r.results || []);
    },
  });

  if (uLoading) {
    return <div className="p-6 text-slate-400 text-sm">Loading…</div>;
  }
  if (!user) {
    return <div className="p-6 text-red-600 text-sm">User not found</div>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-5 text-sm text-slate-400">
        <Link to="/admin/users" className="hover:text-primary-600">Users</Link>
        <span>›</span>
        <span className="text-slate-700">{user.full_name || user.email}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Profile */}
        <div className="card p-5 space-y-3">
          <div className="flex items-center gap-3">
            <Avatar photoUrl={user.photo_url} name={user.full_name} email={user.email} className="w-12 h-12 text-lg" />
            <div>
              <div className="font-semibold text-slate-900">{user.full_name || '—'}</div>
              <div className="text-sm text-slate-400">{user.email}</div>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-3 space-y-2 text-sm">
            <Row label="Role"  value={<span className="badge-blue capitalize">{user.role}</span>} />
            <Row label="OU"    value={<span className="font-mono text-xs">{user.google_ou || '—'}</span>} />
            <Row label="Joined" value={new Date(user.created_at).toLocaleDateString()} />
          </div>
        </div>

        {/* Effective policy */}
        <div className="card p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Effective Policy</h2>
          {policy ? (
            <div className="space-y-2 text-sm">
              <Row label="Policy"   value={<Link to={`/admin/policies/${policy.id}`} className="text-primary-600 hover:underline">{policy.name}</Link>} />
              <Row label="Resolved via" value={policy.resolved_via || '—'} />
              <Row label="Mode"   value={policy.mode || '—'} />
              {policy.lesson_session && (
                <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                  <span className="font-semibold text-amber-700">Active Lesson: </span>
                  <span className="text-amber-700">{policy.lesson_session.name || 'Unnamed'}</span>
                </div>
              )}
              {policy.penalty_box && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-xs">
                  <span className="font-semibold text-red-700">In Penalty Box</span>
                </div>
              )}
              <div className="mt-3">
                <div className="text-xs font-semibold text-slate-500 mb-1.5">Rules ({(policy.rules || []).length})</div>
                {(policy.rules || []).length === 0 ? (
                  <div className="text-xs text-slate-400">No rules configured</div>
                ) : (
                  <ul className="space-y-1">
                    {(policy.rules || []).map((r, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs">
                        <span className={`w-12 text-center rounded px-1 py-0.5 text-xs font-medium
                          ${r.action === 'allow' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {r.action}
                        </span>
                        <span className="font-mono text-slate-600">{r.domain_pattern}</span>
                        {r.comment && <span className="text-slate-400 italic">{r.comment}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="text-slate-400 text-sm">No policy assigned</div>
          )}
        </div>
      </div>

      {/* Recent DNS activity */}
      <div className="card p-5 mt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-700">DNS Activity (last 24h)</h2>
          <div className="flex items-center gap-3">
            <Link to={`/admin/dns/logs?student_id=${userId}`} className="text-xs text-primary-600 hover:underline">
              Full logs →
            </Link>
            <Link to={`/admin/browser-history?student_id=${userId}`} className="text-xs text-primary-600 hover:underline">
              Browser history →
            </Link>
          </div>
        </div>
        {logs.length === 0 ? (
          <div className="text-slate-400 text-sm py-4 text-center">No DNS activity in the last 24h</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="pb-2 text-slate-500 font-semibold">Time</th>
                  <th className="pb-2 text-slate-500 font-semibold">Domain</th>
                  <th className="pb-2 text-slate-500 font-semibold">Type</th>
                  <th className="pb-2 text-slate-500 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {logs.slice(0, 50).map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="py-1.5 pr-4 font-mono text-slate-400 whitespace-nowrap">
                      {new Date(row.queried_at).toLocaleTimeString()}
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-slate-700">{row.domain}</td>
                    <td className="py-1.5 pr-4 text-slate-400">{row.query_type || 'A'}</td>
                    <td className={`py-1.5 font-semibold ${ACTION_COLORS[row.action] || 'text-slate-400'}`}>
                      {row.action}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-slate-500 flex-shrink-0">{label}</span>
      <span className="text-right text-slate-800">{value}</span>
    </div>
  );
}
