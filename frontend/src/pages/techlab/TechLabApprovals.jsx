import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import {
  mdiCheckCircleOutline,
  mdiCloseCircle,
  mdiCheckAll,
} from '@mdi/js';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../lib/api';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function ChangeSummary({ changeType, changeData }) {
  if (!changeData) return null;
  switch (changeType) {
    case 'archive_device':
      return (
        <span>
          Archive device — new status: <strong>{changeData.new_status_label || '—'}</strong>
        </span>
      );
    case 'update_status':
      return (
        <span>
          Update Snipe-IT status ID → <strong>{changeData.new_status_id || '—'}</strong>
          {changeData.notes ? ` (${changeData.notes})` : ''}
        </span>
      );
    case 'parts_transfer':
      return (
        <span>
          {changeData.description || 'Parts transfer'}{' '}
          <span className="font-mono text-xs">
            ({changeData.source_serial || '?'} → {changeData.destination_serial || '?'})
          </span>
        </span>
      );
    case 'update_notes':
      return (
        <span>
          Notes update:{' '}
          {changeData.notes?.length > 100
            ? changeData.notes.slice(0, 100) + '…'
            : changeData.notes || '—'}
        </span>
      );
    default:
      return <span className="font-mono text-xs">{JSON.stringify(changeData)}</span>;
  }
}

export default function TechLabApprovals() {
  const { user } = useAuth();
  const qc       = useQueryClient();

  const isTechInstructor = user?.is_tech_instructor === true;
  const isAdmin          = ['admin', 'superadmin'].includes(user?.role);
  const canAccess        = isTechInstructor || isAdmin;

  // All hooks before any early return
  const { data: approvals = [], isLoading } = useQuery({
    queryKey:        ['techlab-approvals'],
    queryFn:         () => api.get('/tech-lab/instructor/approvals'),
    enabled:         canAccess,
    refetchInterval: 30_000,
  });

  const [rejectId,   setRejectId]   = useState(null);
  const [reviewNote, setReviewNote] = useState('');

  const actionMutation = useMutation({
    mutationFn: ({ changeId, action, review_note }) =>
      api.patch(`/tech-lab/instructor/approvals/${changeId}`, { action, review_note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['techlab-approvals'] });
      setRejectId(null);
      setReviewNote('');
    },
  });

  if (!canAccess) return <Navigate to="/techlab" replace />;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <MdiIcon path={mdiCheckCircleOutline} size="1.2em" className="text-primary-600" />
          Pending Approvals
        </h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Student inventory change requests waiting for your review
        </p>
      </div>

      {isLoading ? (
        <div className="card p-8 text-center text-slate-400 text-sm">Loading…</div>
      ) : approvals.length === 0 ? (
        <div className="card p-12 text-center">
          <MdiIcon path={mdiCheckAll} size="2.5em" className="text-green-400 mx-auto mb-3" />
          <div className="font-semibold text-slate-700">All clear — no pending approvals</div>
          <div className="text-sm text-slate-400 mt-1">
            Students haven't submitted any change requests yet.
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map(item => (
            <div key={item.id} className="card p-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  {/* Ticket title + device */}
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-semibold text-slate-800 text-sm">
                      {item.ticket_title}
                    </span>
                    {item.device_name && (
                      <span className="text-xs text-slate-500">· {item.device_name}</span>
                    )}
                    {item.device_serial && (
                      <span className="font-mono text-xs text-slate-400">
                        ({item.device_serial})
                      </span>
                    )}
                  </div>

                  {/* Change type chip + summary */}
                  <div className="flex items-start gap-2 mb-2 flex-wrap">
                    <span className="badge bg-blue-100 text-blue-800 text-[10px] capitalize flex-shrink-0 whitespace-nowrap">
                      {item.change_type?.replace(/_/g, ' ')}
                    </span>
                    <span className="text-sm text-slate-600">
                      <ChangeSummary
                        changeType={item.change_type}
                        changeData={item.change_data}
                      />
                    </span>
                  </div>

                  {/* Student notes */}
                  {item.student_notes && (
                    <div className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 text-sm text-slate-600 italic mb-2">
                      "{item.student_notes}"
                    </div>
                  )}

                  {/* Submitter + timestamp */}
                  <div className="text-xs text-slate-400">
                    Submitted by{' '}
                    <strong className="text-slate-600">{item.submitter_name}</strong>
                    {' · '}
                    {fmtDate(item.submitted_at)}
                  </div>
                </div>

                {/* Approve / Reject buttons */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    className="btn btn-sm bg-green-600 text-white hover:bg-green-700 focus:ring-green-500"
                    onClick={() =>
                      actionMutation.mutate({ changeId: item.id, action: 'approve' })
                    }
                    disabled={actionMutation.isPending}
                  >
                    <MdiIcon path={mdiCheckCircleOutline} size="0.9em" />
                    Approve
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => setRejectId(item.id)}
                    disabled={actionMutation.isPending}
                  >
                    <MdiIcon path={mdiCloseCircle} size="0.9em" />
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reject modal */}
      {rejectId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="font-bold text-slate-900 mb-4">Reject Change Request</h2>
            <div className="mb-4">
              <label className="label">Rejection Note (optional)</label>
              <textarea
                className="input h-24 resize-none"
                placeholder="Explain why you're rejecting this request…"
                value={reviewNote}
                onChange={e => setReviewNote(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex gap-3">
              <button
                className="btn btn-danger"
                onClick={() =>
                  actionMutation.mutate({
                    changeId:    rejectId,
                    action:      'reject',
                    review_note: reviewNote,
                  })
                }
                disabled={actionMutation.isPending}
              >
                {actionMutation.isPending ? 'Rejecting…' : 'Confirm Reject'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => { setRejectId(null); setReviewNote(''); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
