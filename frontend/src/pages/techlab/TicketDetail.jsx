import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import {
  mdiChevronLeft,
  mdiLaptop,
  mdiLock,
  mdiAlertCircle,
  mdiTrashCanOutline,
} from '@mdi/js';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const STATUS_BADGE = {
  open:             'badge-blue',
  in_progress:      'badge-yellow',
  pending_approval: 'bg-orange-100 text-orange-800 badge',
  approved:         'badge-green',
  rejected:         'badge-red',
  closed:           'badge-slate',
};
const STATUS_LABEL = {
  open:             'Open',
  in_progress:      'In Progress',
  pending_approval: 'Pending Approval',
  approved:         'Approved',
  rejected:         'Rejected',
  closed:           'Closed',
};
const PRIORITY_BADGE = {
  low:    'badge-slate',
  normal: 'badge-blue',
  high:   'badge-red',
};
const NOTE_TYPE_LABEL = {
  note:            'Note',
  diagnostic:      'Diagnostic',
  parts_harvested: 'Parts Harvested',
  parts_installed: 'Parts Installed',
  approval_note:   'Approval Note',
};
const NOTE_TYPE_COLOR = {
  note:            'bg-slate-100 text-slate-700',
  diagnostic:      'bg-blue-100 text-blue-700',
  parts_harvested: 'bg-amber-100 text-amber-700',
  parts_installed: 'bg-green-100 text-green-700',
  approval_note:   'bg-purple-100 text-purple-700',
};
const CHANGE_TYPE_OPTIONS = [
  { value: 'archive_device', label: 'Archive Device' },
  { value: 'update_status',  label: 'Update Snipe-IT Status' },
  { value: 'parts_transfer', label: 'Parts Transfer' },
  { value: 'update_notes',   label: 'Update Notes' },
];
const ALL_STATUSES = ['open', 'in_progress', 'pending_approval', 'approved', 'rejected', 'closed'];

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------
function StatusBadge({ status }) {
  return (
    <span className={STATUS_BADGE[status] || 'badge badge-slate'}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function ChangeSummary({ changeType, changeData }) {
  if (!changeData) return null;
  switch (changeType) {
    case 'archive_device':
      return <span>Archive device — new status: <strong>{changeData.new_status_label || '—'}</strong></span>;
    case 'update_status':
      return <span>Update Snipe-IT status ID to <strong>{changeData.new_status_id || '—'}</strong>{changeData.notes ? ` (${changeData.notes})` : ''}</span>;
    case 'parts_transfer':
      return (
        <span>
          Parts transfer: {changeData.description || '—'}
          <br />
          <span className="font-mono text-xs">
            {changeData.source_serial || '?'} → {changeData.destination_serial || '?'}
          </span>
        </span>
      );
    case 'update_notes':
      return <span>Notes update: {changeData.notes || '—'}</span>;
    default:
      return <span className="font-mono text-xs">{JSON.stringify(changeData)}</span>;
  }
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function TicketDetail() {
  const { id }   = useParams();
  const { user } = useAuth();
  const navigate  = useNavigate();
  const qc        = useQueryClient();

  const isAdmin        = ['admin', 'superadmin'].includes(user?.role);
  const isTechInstructor = user?.is_tech_instructor === true;
  const isStudentTech  = user?.role === 'student_technician';
  const canManage      = isTechInstructor || isAdmin;

  // ── Data ──────────────────────────────────────────────────────────────────
  const { data: ticket, isLoading, error: loadError } = useQuery({
    queryKey: ['techlab-ticket', id],
    queryFn:  () => api.get(`/tech-lab/tickets/${id}`),
  });

  // ── Local state ───────────────────────────────────────────────────────────
  const [noteContent, setNoteContent] = useState('');
  const [noteType,    setNoteType]    = useState('note');
  const [notePrivate, setNotePrivate] = useState(false);
  const [noteError,   setNoteError]   = useState('');

  const [changeType,  setChangeType]  = useState('archive_device');
  const [changeData,  setChangeData]  = useState({});
  const [changeNotes, setChangeNotes] = useState('');
  const [changeError, setChangeError] = useState('');

  const [rejectChangeId, setRejectChangeId] = useState(null);
  const [reviewNote,     setReviewNote]     = useState('');

  // ── Mutations ─────────────────────────────────────────────────────────────
  const addNoteMutation = useMutation({
    mutationFn: (body) => api.post(`/tech-lab/tickets/${id}/notes`, body),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['techlab-ticket', id] });
      setNoteContent('');
      setNoteError('');
    },
    onError: (err) => setNoteError(err.message || 'Failed to add note'),
  });

  const updateStatusMutation = useMutation({
    mutationFn: (body) => api.patch(`/tech-lab/tickets/${id}`, body),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['techlab-ticket', id] }),
  });

  const submitChangeMutation = useMutation({
    mutationFn: (body) => api.post(`/tech-lab/tickets/${id}/pending-changes`, body),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['techlab-ticket', id] });
      setChangeData({});
      setChangeNotes('');
      setChangeError('');
    },
    onError: (err) => setChangeError(err.message || 'Failed to submit change'),
  });

  const deleteChangeMutation = useMutation({
    mutationFn: (changeId) => api.delete(`/tech-lab/tickets/${id}/pending-changes/${changeId}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['techlab-ticket', id] }),
  });

  const approveChangeMutation = useMutation({
    mutationFn: ({ changeId, action, review_note }) =>
      api.patch(`/tech-lab/instructor/approvals/${changeId}`, { action, review_note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['techlab-ticket', id] });
      qc.invalidateQueries({ queryKey: ['techlab-approvals'] });
      setRejectChangeId(null);
      setReviewNote('');
    },
  });

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleAddNote = () => {
    if (!noteContent.trim()) { setNoteError('Note content is required'); return; }
    setNoteError('');
    addNoteMutation.mutate({
      content:    noteContent.trim(),
      note_type:  noteType,
      is_private: canManage ? notePrivate : false,
    });
  };

  const buildChangeData = () => {
    switch (changeType) {
      case 'archive_device':
        if (!changeData.confirm) return null;
        return { new_status_label: changeData.new_status_label || 'Archived' };
      case 'update_status':
        if (!changeData.new_status_id) return null;
        return { new_status_id: changeData.new_status_id, notes: changeData.notes || '' };
      case 'parts_transfer':
        return {
          description:        changeData.description        || '',
          source_serial:      changeData.source_serial      || '',
          destination_serial: changeData.destination_serial || '',
        };
      case 'update_notes':
        return { notes: changeData.notes || '' };
      default:
        return {};
    }
  };

  const handleSubmitChange = () => {
    const cd = buildChangeData();
    if (cd === null) { setChangeError('Please fill in all required fields for this change type'); return; }
    submitChangeMutation.mutate({
      change_type:   changeType,
      change_data:   cd,
      student_notes: changeNotes,
    });
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const notes          = ticket?.notes         || [];
  const pendingChanges = ticket?.pending_changes || [];
  const visibleNotes   = canManage ? notes : notes.filter(n => !n.is_private);

  // What statuses a student tech can transition to from the current status
  const studentNextStatuses = (() => {
    if (!ticket) return [];
    const map = { open: ['in_progress'], in_progress: ['open', 'closed'] };
    return map[ticket.status] || [];
  })();

  // ── Loading / error states ────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-100 rounded w-64" />
          <div className="h-32 bg-slate-100 rounded" />
        </div>
      </div>
    );
  }

  if (loadError || !ticket) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm">
          {loadError?.message || 'Ticket not found.'}
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      {/* Back link */}
      <button
        className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        onClick={() => navigate('/techlab')}
      >
        <MdiIcon path={mdiChevronLeft} size="1em" />
        Back to Tech Lab
      </button>

      {/* ── Ticket header card ────────────────────────────────────────────── */}
      <div className="card p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{ticket.title}</h1>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <StatusBadge status={ticket.status} />
              <span className={`${PRIORITY_BADGE[ticket.priority] || 'badge-slate'} badge`}>
                {ticket.priority || 'normal'} priority
              </span>
              <span className="text-xs text-slate-400">Created {fmtDate(ticket.created_at)}</span>
            </div>
          </div>

          {/* Status controls */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Student tech: discrete next-status buttons */}
            {isStudentTech && studentNextStatuses.map(s => (
              <button
                key={s}
                className={`btn btn-sm ${s === 'closed' ? 'btn-secondary' : 'btn-primary'}`}
                onClick={() => updateStatusMutation.mutate({ status: s })}
                disabled={updateStatusMutation.isPending}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
            {/* Instructor / admin: full dropdown */}
            {canManage && (
              <select
                className="input text-xs py-1 px-2 w-auto"
                value={ticket.status}
                onChange={e => updateStatusMutation.mutate({ status: e.target.value })}
                disabled={updateStatusMutation.isPending}
              >
                {ALL_STATUSES.map(s => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Device info */}
        {(ticket.device_serial || ticket.device_name) && (
          <div className="mt-4 pt-4 border-t border-slate-100 flex items-center gap-3">
            <MdiIcon path={mdiLaptop} size="1.2em" className="text-slate-400 flex-shrink-0" />
            <div>
              <div className="font-medium text-slate-800 text-sm">
                {ticket.device_name || ticket.device_serial}
              </div>
              <div className="text-xs text-slate-500">
                {ticket.device_model && <span>{ticket.device_model} · </span>}
                {ticket.device_serial && (
                  <span className="font-mono">{ticket.device_serial}</span>
                )}
                {ticket.snipeit_asset_tag && (
                  <span> · Asset: {ticket.snipeit_asset_tag}</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Initial condition */}
        {ticket.initial_condition && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <div className="label">Initial Condition</div>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{ticket.initial_condition}</p>
          </div>
        )}
      </div>

      {/* ── Work log card ─────────────────────────────────────────────────── */}
      <div className="card p-6">
        <h2 className="font-semibold text-slate-800 mb-4">Work Log</h2>

        {/* Notes list */}
        {visibleNotes.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">
            No notes yet. Add the first note below.
          </p>
        ) : (
          <div className="space-y-5 mb-6">
            {visibleNotes.map(note => (
              <div key={note.id} className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-slate-200 flex-shrink-0 flex items-center justify-center text-xs font-semibold text-slate-600">
                  {(note.author_name || '?')[0].toUpperCase()}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-sm font-semibold text-slate-800">
                      {note.author_name || 'Unknown'}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        NOTE_TYPE_COLOR[note.note_type] || 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {NOTE_TYPE_LABEL[note.note_type] || note.note_type}
                    </span>
                    {note.is_private && (
                      <span className="flex items-center gap-0.5 text-[10px] text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-full">
                        <MdiIcon path={mdiLock} size="0.7em" />
                        Private
                      </span>
                    )}
                    <span className="text-xs text-slate-400 ml-auto">{fmtDate(note.created_at)}</span>
                  </div>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{note.content}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add note form */}
        <div className="border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Add Note</h3>
          {noteError && (
            <div className="mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {noteError}
            </div>
          )}
          <div className="space-y-3">
            <div>
              <label className="label">Note Type</label>
              <select
                className="input"
                value={noteType}
                onChange={e => setNoteType(e.target.value)}
              >
                {Object.entries(NOTE_TYPE_LABEL).map(([val, lbl]) => (
                  <option key={val} value={val}>{lbl}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Content</label>
              <textarea
                className="input h-24 resize-none"
                placeholder="Describe what you did, found, or observed…"
                value={noteContent}
                onChange={e => setNoteContent(e.target.value)}
              />
            </div>
            {canManage && (
              <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={notePrivate}
                  onChange={e => setNotePrivate(e.target.checked)}
                  className="rounded"
                />
                Private note (instructor only)
              </label>
            )}
            <button
              className="btn btn-primary btn-sm"
              onClick={handleAddNote}
              disabled={addNoteMutation.isPending}
            >
              {addNoteMutation.isPending ? 'Adding…' : 'Add Note'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Pending inventory changes ─────────────────────────────────────── */}
      {pendingChanges.length > 0 && (
        <div className="card p-6">
          <h2 className="font-semibold text-slate-800 mb-4">Inventory Change Requests</h2>
          <div className="space-y-3">
            {pendingChanges.map(change => (
              <div key={change.id} className="border border-slate-200 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-semibold text-slate-800 capitalize">
                        {change.change_type?.replace(/_/g, ' ')}
                      </span>
                      <span
                        className={`badge text-[10px] ${
                          change.status === 'approved' ? 'badge-green' :
                          change.status === 'rejected' ? 'badge-red'  :
                          'bg-orange-100 text-orange-800'
                        }`}
                      >
                        {change.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 mb-1">
                      <ChangeSummary changeType={change.change_type} changeData={change.change_data} />
                    </p>
                    {change.student_notes && (
                      <p className="text-xs text-slate-500 italic">"{change.student_notes}"</p>
                    )}
                    {change.review_note && (
                      <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded p-2">
                        Instructor note: {change.review_note}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* Instructor / admin approval inline on the ticket */}
                    {canManage && change.status === 'pending' && (
                      <>
                        <button
                          className="btn btn-sm bg-green-600 text-white hover:bg-green-700 focus:ring-green-500"
                          onClick={() => approveChangeMutation.mutate({ changeId: change.id, action: 'approve' })}
                          disabled={approveChangeMutation.isPending}
                        >
                          Approve
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => setRejectChangeId(change.id)}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {/* Student can withdraw pending changes */}
                    {isStudentTech && change.status === 'pending' && (
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => deleteChangeMutation.mutate(change.id)}
                        disabled={deleteChangeMutation.isPending}
                        title="Withdraw change request"
                      >
                        <MdiIcon path={mdiTrashCanOutline} size="1em" />
                        Withdraw
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Submit inventory change ───────────────────────────────────────── */}
      <div className="card p-6">
        <h2 className="font-semibold text-slate-800 mb-1">Submit Inventory Change Request</h2>
        <p className="text-sm text-slate-500 mb-5">
          Propose a change to Snipe-IT inventory. Your instructor will review and approve it.
        </p>

        {changeError && (
          <div className="mb-4 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center gap-2">
            <MdiIcon path={mdiAlertCircle} size="1em" className="flex-shrink-0" />
            {changeError}
          </div>
        )}

        <div className="space-y-4">
          {/* Change type */}
          <div>
            <label className="label">Change Type</label>
            <select
              className="input"
              value={changeType}
              onChange={e => { setChangeType(e.target.value); setChangeData({}); }}
            >
              {CHANGE_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Dynamic fields by type */}
          {changeType === 'archive_device' && (
            <div className="space-y-3">
              <div>
                <label className="label">New Status Label</label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. Archived, Retired, Parts Only"
                  value={changeData.new_status_label || ''}
                  onChange={e => setChangeData(d => ({ ...d, new_status_label: e.target.value }))}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={changeData.confirm || false}
                  onChange={e => setChangeData(d => ({ ...d, confirm: e.target.checked }))}
                />
                I confirm this device should be archived
              </label>
            </div>
          )}

          {changeType === 'update_status' && (
            <div className="space-y-3">
              <div>
                <label className="label">New Snipe-IT Status ID</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Status ID number"
                  value={changeData.new_status_id || ''}
                  onChange={e => setChangeData(d => ({ ...d, new_status_id: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea
                  className="input h-20 resize-none"
                  placeholder="Why is this status being changed?"
                  value={changeData.notes || ''}
                  onChange={e => setChangeData(d => ({ ...d, notes: e.target.value }))}
                />
              </div>
            </div>
          )}

          {changeType === 'parts_transfer' && (
            <div className="space-y-3">
              <div>
                <label className="label">Description</label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. Screen transplant from retired unit"
                  value={changeData.description || ''}
                  onChange={e => setChangeData(d => ({ ...d, description: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Source Serial</label>
                  <input
                    type="text"
                    className="input font-mono"
                    placeholder="Donor device"
                    value={changeData.source_serial || ''}
                    onChange={e => setChangeData(d => ({ ...d, source_serial: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label">Destination Serial</label>
                  <input
                    type="text"
                    className="input font-mono"
                    placeholder="Recipient device"
                    value={changeData.destination_serial || ''}
                    onChange={e => setChangeData(d => ({ ...d, destination_serial: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          )}

          {changeType === 'update_notes' && (
            <div>
              <label className="label">Notes</label>
              <textarea
                className="input h-24 resize-none"
                placeholder="Notes to update in Snipe-IT"
                value={changeData.notes || ''}
                onChange={e => setChangeData(d => ({ ...d, notes: e.target.value }))}
              />
            </div>
          )}

          {/* Student explanation */}
          <div>
            <label className="label">Explanation for Instructor</label>
            <textarea
              className="input h-20 resize-none"
              placeholder="Why is this change needed? What did you observe?"
              value={changeNotes}
              onChange={e => setChangeNotes(e.target.value)}
            />
          </div>

          <button
            className="btn btn-primary"
            onClick={handleSubmitChange}
            disabled={submitChangeMutation.isPending}
          >
            {submitChangeMutation.isPending ? 'Submitting…' : 'Submit Change Request'}
          </button>
        </div>
      </div>

      {/* ── Reject modal ─────────────────────────────────────────────────── */}
      {rejectChangeId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="font-bold text-slate-900 mb-4">Reject Change Request</h2>
            <div className="mb-4">
              <label className="label">Rejection Note (optional)</label>
              <textarea
                className="input h-24 resize-none"
                placeholder="Explain why this change is being rejected…"
                value={reviewNote}
                onChange={e => setReviewNote(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex gap-3">
              <button
                className="btn btn-danger"
                onClick={() => approveChangeMutation.mutate({
                  changeId:    rejectChangeId,
                  action:      'reject',
                  review_note: reviewNote,
                })}
                disabled={approveChangeMutation.isPending}
              >
                {approveChangeMutation.isPending ? 'Rejecting…' : 'Reject'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => { setRejectChangeId(null); setReviewNote(''); }}
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
