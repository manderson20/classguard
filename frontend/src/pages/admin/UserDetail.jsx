import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import api from '../../lib/api';
import Avatar from '../../components/Avatar';
import { useAuth } from '../../contexts/AuthContext';
import LiveViewModal from '../../components/LiveViewModal';

const ROLES = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

const ACTION_COLORS = {
  allowed: 'text-green-600',
  blocked: 'text-red-600',
  unknown: 'text-slate-400',
};

const HISTORY_ACTION_COLORS = {
  allowed: 'text-green-600',
  blocked: 'text-red-600',
};

export default function UserDetail() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { user: viewer, startImpersonation } = useAuth();
  const [liveViewOpen, setLiveViewOpen] = useState(false);
  const canLiveView = (ROLES[viewer?.role] ?? 0) >= ROLES.admin;
  const isAdmin       = (ROLES[viewer?.role] ?? 0) >= ROLES.admin;
  const isSuperAdmin = (ROLES[viewer?.role] ?? 0) >= ROLES.superadmin;

  const { data: myPermissions } = useQuery({
    queryKey: ['my-permissions'],
    queryFn:  () => api.get('/users/me/permissions'),
    enabled:  isAdmin,
    staleTime: 60_000,
  });
  const canImpersonate = isSuperAdmin || myPermissions?.unrestricted ||
    myPermissions?.permissions?.includes('impersonate_users');

  const [impersonateError, setImpersonateError] = useState(null);
  const impersonate = useMutation({
    mutationFn: () => startImpersonation(userId),
    onSuccess:  () => navigate('/classes'),
    onError:    (err) => setImpersonateError(err.message),
  });

  // Parent report — screen time + flagged safety events only (no raw
  // browsing history, no screenshot images), see services/parentReport.js.
  // Binary PDF response, so it goes through a raw fetch + blob download
  // rather than the JSON-only `api` helper.
  const [reportOpen, setReportOpen] = useState(false);
  const [reportFrom, setReportFrom] = useState(() => new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  const [reportTo, setReportTo]     = useState(() => new Date().toISOString().slice(0, 10));
  const [reportError, setReportError] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);

  const downloadParentReport = async () => {
    setReportError(null);
    setReportLoading(true);
    try {
      const token = localStorage.getItem('cg_token');
      const params = new URLSearchParams({ from: reportFrom, to: reportTo });
      const res = await fetch(`/api/v1/parent-report/${userId}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to generate report (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `parent-report-${(user?.full_name || 'student').replace(/\s+/g, '-')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setReportOpen(false);
    } catch (err) {
      setReportError(err.message);
    } finally {
      setReportLoading(false);
    }
  };

  // Local-password fallback (not just for accounts created locally — this
  // also works on a Google-synced account, so there's always a way in if
  // Google SSO itself is ever the thing that's broken).
  const [resetOpen, setResetOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [resetResult, setResetResult] = useState(null);
  const resetPassword = useMutation({
    mutationFn: () => api.put(`/users/${userId}/password`, { password: newPassword }),
    onSuccess:  () => { setResetResult({ ok: true, msg: 'Password updated.' }); setNewPassword(''); },
    onError:    (err) => setResetResult({ ok: false, msg: err.message }),
  });

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

  const { data: history = [] } = useQuery({
    queryKey: ['user-browser-history', userId],
    queryFn:  () => {
      const from = new Date(Date.now() - 86400_000).toISOString();
      return api.get(`/extension/browser-history?student_id=${userId}&from=${from}&limit=50`).then(r => r.results || []);
    },
  });

  const { data: infosecData } = useQuery({
    queryKey: ['user-infoseciq', user?.email],
    queryFn:  () => api.get(`/infoseciq/learners/by-email/${encodeURIComponent(user.email)}`),
    enabled:  !!user?.email,
    retry:    false,
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
            <Avatar photoUrl={user.photo_url} name={user.full_name} email={user.email} className="w-12 h-12 text-lg flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-slate-900 truncate" title={user.full_name}>{user.full_name || '—'}</div>
              <div className="text-sm text-slate-400 truncate" title={user.email}>{user.email}</div>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-3 space-y-2 text-sm">
            <Row label="Role"  value={<span className="badge-blue capitalize">{user.role}</span>} />
            <Row label="OU"    value={<span className="font-mono text-xs">{user.google_ou || '—'}</span>} />
            <Row label="Joined" value={new Date(user.created_at).toLocaleDateString()} />
          </div>

          {canLiveView && user.role === 'student' && (
            <button
              onClick={() => setLiveViewOpen(true)}
              className="btn-secondary text-sm w-full mt-1"
            >
              View Browser
            </button>
          )}

          {user.role === 'student' && (
            <div className="mt-1">
              {!reportOpen ? (
                <button onClick={() => { setReportOpen(true); setReportError(null); }} className="btn-secondary text-sm w-full">
                  Generate Parent Report
                </button>
              ) : (
                <div className="space-y-2 border border-slate-200 rounded-lg p-3">
                  <p className="text-xs text-slate-500">Screen time and flagged safety events only — no raw browsing history or screenshots.</p>
                  <div className="flex items-center gap-2">
                    <input type="date" className="input text-xs flex-1" value={reportFrom} onChange={e => setReportFrom(e.target.value)} />
                    <span className="text-slate-400 text-xs">to</span>
                    <input type="date" className="input text-xs flex-1" value={reportTo} onChange={e => setReportTo(e.target.value)} />
                  </div>
                  {reportError && <p className="text-xs text-red-600">{reportError}</p>}
                  <div className="flex items-center gap-2">
                    <button className="btn-primary text-sm" disabled={reportLoading} onClick={downloadParentReport}>
                      {reportLoading ? 'Generating…' : 'Download PDF'}
                    </button>
                    <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setReportOpen(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {canImpersonate && user.role === 'teacher' && user.id !== viewer?.id && (
            <div className="mt-1">
              <button
                onClick={() => { setImpersonateError(null); impersonate.mutate(); }}
                disabled={impersonate.isPending}
                className="btn-secondary text-sm w-full disabled:opacity-60"
              >
                {impersonate.isPending ? 'Starting…' : 'View as this teacher'}
              </button>
              <p className="text-[11px] text-slate-400 mt-1">
                Opens a 30-minute session as {user.full_name || 'this teacher'}. Logged in Impersonation Audit.
              </p>
              {impersonateError && (
                <p className="text-xs text-red-600 mt-1">{impersonateError}</p>
              )}
            </div>
          )}

          {isSuperAdmin && (
            <div className="border-t border-slate-100 pt-3">
              {!resetOpen ? (
                <button
                  onClick={() => { setResetOpen(true); setResetResult(null); }}
                  className="btn-secondary text-sm w-full"
                >
                  Set / Reset Local Password
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-slate-500">
                    Sets a local password for this account — works even if it normally signs in via Google,
                    as a fallback if SSO is ever unavailable.
                  </p>
                  <input
                    type="password"
                    className="input text-sm w-full"
                    placeholder="New password (10+ characters)"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      className="btn-primary text-sm"
                      disabled={newPassword.length < 10 || resetPassword.isPending}
                      onClick={() => resetPassword.mutate()}
                    >
                      {resetPassword.isPending ? 'Saving…' : 'Save Password'}
                    </button>
                    <button
                      className="text-xs text-slate-400 hover:text-slate-600"
                      onClick={() => { setResetOpen(false); setNewPassword(''); setResetResult(null); }}
                    >
                      Cancel
                    </button>
                  </div>
                  {resetResult && (
                    <p className={`text-xs font-medium ${resetResult.ok ? 'text-green-600' : 'text-red-600'}`}>{resetResult.msg}</p>
                  )}
                </div>
              )}
            </div>
          )}
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

      {/* Recent activity — DNS-level and extension-level side by side, same window */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        {/* DNS activity */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">DNS Activity (last 24h)</h2>
            <Link to={`/admin/dns/logs?student_id=${userId}`} className="text-xs text-primary-600 hover:underline whitespace-nowrap">
              Full logs →
            </Link>
          </div>
          {logs.length === 0 ? (
            <div className="text-slate-400 text-sm py-4 text-center">No DNS activity in the last 24h</div>
          ) : (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="pb-2 text-slate-500 font-semibold">Time</th>
                    <th className="pb-2 text-slate-500 font-semibold">Domain</th>
                    <th className="pb-2 text-slate-500 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {logs.slice(0, 50).map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="py-1.5 pr-3 font-mono text-slate-400 whitespace-nowrap">
                        {new Date(row.queried_at).toLocaleTimeString()}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-slate-700 truncate max-w-[140px]" title={row.domain}>
                        {row.domain}
                      </td>
                      <td className={`py-1.5 font-semibold whitespace-nowrap ${ACTION_COLORS[row.action] || 'text-slate-400'}`}>
                        {row.action}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Extension activity (browser history) */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">Extension Activity (last 24h)</h2>
            <Link to={`/admin/browser-history?student_id=${userId}`} className="text-xs text-primary-600 hover:underline whitespace-nowrap">
              Full history →
            </Link>
          </div>
          {history.length === 0 ? (
            <div className="text-slate-400 text-sm py-4 text-center">No extension activity in the last 24h</div>
          ) : (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="pb-2 text-slate-500 font-semibold">Time</th>
                    <th className="pb-2 text-slate-500 font-semibold">Page</th>
                    <th className="pb-2 text-slate-500 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {history.slice(0, 50).map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="py-1.5 pr-3 font-mono text-slate-400 whitespace-nowrap">
                        {new Date(row.visited_at).toLocaleTimeString()}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-700 truncate max-w-[140px]" title={row.url}>
                        {row.title || row.url}
                      </td>
                      <td className={`py-1.5 font-semibold whitespace-nowrap ${HISTORY_ACTION_COLORS[row.action] || 'text-slate-400'}`}>
                        {row.action || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {/* Infosec IQ grade card — only shown for users who are Infosec IQ learners */}
        {infosecData && (
          <div className="card p-5 lg:col-span-3">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-slate-700">Security Awareness — Infosec IQ</h2>
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => {
                    const token = localStorage.getItem('cg_token');
                    fetch(`/api/v1/infoseciq/exit-ticket/${encodeURIComponent(user.email)}`, {
                      headers: { Authorization: `Bearer ${token}` },
                    }).then(r => r.blob()).then(blob => {
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(blob);
                      a.download = `exit-ticket-${(user.full_name || user.email).replace(/\s+/g, '-')}.pdf`;
                      a.click();
                    });
                  }}
                  className="text-xs px-3 py-1 rounded-lg bg-primary-600 text-white hover:bg-primary-700 font-medium"
                >
                  Exit Ticket PDF
                </button>
                <a href="/admin/infoseciq/grade-cards" className="text-xs text-primary-600 hover:underline">
                  View all →
                </a>
              </div>
            </div>

            <div className="flex gap-6 flex-wrap items-start">
              {/* Grade badge */}
              <div className="flex flex-col items-center gap-1 flex-shrink-0">
                <div className={`w-16 h-16 rounded-xl flex items-center justify-center text-3xl font-bold border-2 ${
                  infosecData.letter_grade === 'A' ? 'bg-green-50  border-green-300  text-green-700' :
                  infosecData.letter_grade === 'B' ? 'bg-blue-50   border-blue-300   text-blue-700'  :
                  infosecData.letter_grade === 'C' ? 'bg-yellow-50 border-yellow-300 text-yellow-700':
                  infosecData.letter_grade === 'D' ? 'bg-orange-50 border-orange-300 text-orange-700':
                  infosecData.letter_grade === 'F' ? 'bg-red-50    border-red-300    text-red-700'   :
                  'bg-slate-50 border-slate-200 text-slate-400'
                }`}>
                  {infosecData.letter_grade || '—'}
                </div>
                <span className="text-xs text-slate-400">Grade</span>
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1">
                {[
                  { label: 'Grade Score',      value: infosecData.grade_score ? `${infosecData.grade_score}/100` : '—' },
                  { label: 'Training Complete', value: `${Math.round(infosecData.training_completion_pct || 0)}%` },
                  { label: 'Times Phished',    value: infosecData.phished_count ?? 0,
                    cls: (infosecData.phished_count > 2) ? 'text-red-600' : (infosecData.phished_count > 0) ? 'text-orange-600' : 'text-green-600' },
                  { label: 'Data Entry Events',value: infosecData.data_entry_count ?? 0,
                    cls: (infosecData.data_entry_count > 0) ? 'text-red-600' : '' },
                  { label: 'Modules Assigned', value: infosecData.modules_enrolled ?? infosecData.courses_assigned ?? 0 },
                  { label: 'Modules Completed',value: infosecData.modules_completed ?? infosecData.courses_completed ?? 0 },
                  { label: 'Time Trained',     value: infosecData.training_time_minutes ? `${infosecData.training_time_minutes} min` : '—' },
                  { label: 'Last Activity',    value: infosecData.last_activity_at ? new Date(infosecData.last_activity_at).toLocaleDateString() : '—' },
                ].map(s => (
                  <div key={s.label} className="bg-slate-50 rounded-lg px-3 py-2">
                    <div className="text-xs text-slate-400 uppercase tracking-wide">{s.label}</div>
                    <div className={`font-semibold text-sm mt-0.5 ${s.cls || 'text-slate-800'}`}>{s.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Training completion bar */}
            <div className="mt-4">
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>Training Completion</span>
                <span>{infosecData.modules_completed ?? 0} / {infosecData.modules_enrolled ?? 0} modules</span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    (infosecData.training_completion_pct || 0) >= 80 ? 'bg-green-500' :
                    (infosecData.training_completion_pct || 0) >= 50 ? 'bg-yellow-400' : 'bg-red-400'
                  }`}
                  style={{ width: `${Math.min(100, infosecData.training_completion_pct || 0)}%` }}
                />
              </div>
            </div>

            {/* Phishing history */}
            {infosecData.phishing_history?.length > 0 && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Recent Phishing Campaigns</h3>
                <div className="space-y-1">
                  {infosecData.phishing_history.slice(0, 5).map((h, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs py-1 border-b border-slate-50 last:border-0">
                      <span className="flex-1 font-medium text-slate-700 truncate">{h.campaign_name}</span>
                      <div className="flex gap-1.5 flex-shrink-0">
                        {h.clicked_at  && <span className="px-1.5 py-0.5 rounded bg-red-100    text-red-700    font-medium">Clicked</span>}
                        {h.opened_at && !h.clicked_at && <span className="px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 font-medium">Opened</span>}
                        {h.reported_at && <span className="px-1.5 py-0.5 rounded bg-green-100  text-green-700  font-medium">Reported</span>}
                        {!h.clicked_at && !h.opened_at && !h.reported_at && <span className="text-slate-400">No action</span>}
                      </div>
                      <span className="text-slate-400 w-20 text-right flex-shrink-0">
                        {h.sent_at ? new Date(h.sent_at).toLocaleDateString() : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {liveViewOpen && (
        <LiveViewModal student={user} onClose={() => setLiveViewOpen(false)} />
      )}
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
