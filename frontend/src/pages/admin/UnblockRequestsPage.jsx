import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const STATUS_STYLES = {
  pending:  'bg-amber-100  text-amber-800  border border-amber-200',
  approved: 'bg-green-100  text-green-800  border border-green-200',
  denied:   'bg-red-100    text-red-700    border border-red-200',
};

const HOURS_OPTIONS = [
  { label: '30 minutes', value: 0.5 },
  { label: '1 hour',     value: 1   },
  { label: '4 hours',    value: 4   },
  { label: '1 day',      value: 24  },
  { label: '3 days',     value: 72  },
];

function OverrideCodeModal({ request, onClose }) {
  const qc = useQueryClient();
  const [hours,  setHours]  = useState(4);
  const [notes,  setNotes]  = useState('');
  const [code,   setCode]   = useState(null);

  const generate = useMutation({
    mutationFn: () => api.post('/override-codes', {
      domain:              request.domain,
      duration_hours:      hours,
      notes:               notes || null,
      unblock_request_id:  request.id,
    }),
    onSuccess: data => {
      setCode(data.code);
      qc.invalidateQueries(['unblock-requests']);
    },
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-bold text-slate-900 mb-1">Generate Override Code</h2>
        <p className="text-sm text-slate-500 mb-4">
          Creates a one-time code for <span className="font-mono font-semibold text-slate-700">{request.domain}</span>.
          Give the code to the student verbally or via chat. It cannot be regenerated.
        </p>

        {!code ? (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-700 mb-1">Valid for</label>
              <select className="input text-sm" value={hours} onChange={e => setHours(parseFloat(e.target.value))}>
                {HOURS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-700 mb-1">Notes <span className="text-slate-400 font-normal">(optional)</span></label>
              <input className="input text-sm" placeholder="e.g. Approved for research project"
                value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
            <div className="flex gap-3 mt-5">
              <button className="btn-primary flex-1" onClick={() => generate.mutate()} disabled={generate.isPending}>
                {generate.isPending ? 'Generating…' : 'Generate Code'}
              </button>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
            </div>
            {generate.error && (
              <p className="text-red-600 text-sm mt-3">{generate.error.message}</p>
            )}
          </>
        ) : (
          <div className="text-center">
            <div className="bg-slate-50 border-2 border-dashed border-slate-300 rounded-xl py-6 px-4 mb-4">
              <p className="text-xs text-slate-500 mb-2 uppercase tracking-wide font-semibold">Override Code</p>
              <p className="text-4xl font-black tracking-[.3em] font-mono text-slate-800">{code}</p>
              <p className="text-xs text-slate-400 mt-2">Valid for {hours < 1 ? '30 minutes' : `${hours} hour${hours !== 1 ? 's' : ''}`} · Single-use</p>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Share this code with the student. It will allow access to <strong>{request.domain}</strong> for the specified duration.
              CIPA-protected content cannot be overridden.
            </p>
            <div className="flex gap-3">
              <button className="btn-secondary flex-1"
                onClick={() => navigator.clipboard.writeText(code)}>
                Copy Code
              </button>
              <button className="btn-primary flex-1" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DenyModal({ request, onClose }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');

  const deny = useMutation({
    mutationFn: () => api.patch(`/unblock-requests/${request.id}`, { status: 'denied', review_note: note }),
    onSuccess:  () => { qc.invalidateQueries(['unblock-requests']); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 className="text-lg font-bold text-slate-900 mb-1">Deny Request</h2>
        <p className="text-sm text-slate-500 mb-4">
          Deny access to <span className="font-mono font-semibold text-slate-700">{request.domain}</span>
          {request.student_name ? ` for ${request.student_name}` : ''}.
        </p>
        <label className="block text-sm font-medium text-slate-700 mb-1">Note <span className="text-slate-400 font-normal">(optional)</span></label>
        <textarea className="input text-sm resize-none" rows={3}
          placeholder="Reason for denial (not shown to student)"
          value={note} onChange={e => setNote(e.target.value)} />
        <div className="flex gap-3 mt-4">
          <button className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
            onClick={() => deny.mutate()} disabled={deny.isPending}>
            {deny.isPending ? 'Denying…' : 'Deny Request'}
          </button>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function UnblockRequestsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('pending');
  const [modal, setModal] = useState(null); // { type: 'override'|'deny', request }

  const { data, isLoading } = useQuery({
    queryKey: ['unblock-requests', statusFilter],
    queryFn:  () => api.get(`/unblock-requests?status=${statusFilter}`),
    refetchInterval: statusFilter === 'pending' ? 30_000 : false,
  });

  const approve = useMutation({
    mutationFn: id => api.patch(`/unblock-requests/${id}`, { status: 'approved' }),
    onSuccess:  () => qc.invalidateQueries(['unblock-requests']),
  });

  const requests = data?.requests || [];
  const total    = data?.total    || 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Unblock Requests</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Students and staff can request access to blocked sites from the block page.
        </p>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-5">
        {['pending', 'approved', 'denied'].map(s => (
          <button key={s}
            className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors capitalize ${
              statusFilter === s
                ? 'bg-primary-600 text-white border-primary-600'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
            onClick={() => setStatusFilter(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : requests.length === 0 ? (
        <div className="card p-12 text-center text-slate-400">
          <div className="text-3xl mb-3">📬</div>
          <div className="font-medium">No {statusFilter} requests</div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Domain</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Requester</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Reason</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Requested</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                {statusFilter === 'pending' && (
                  <th className="px-4 py-3"></th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {requests.map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <span className="font-mono text-slate-800 font-medium">{r.domain}</span>
                    {r.source_ip && <div className="text-xs text-slate-400">{r.source_ip}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-700">{r.student_name || r.requester_name || '—'}</div>
                    <div className="text-xs text-slate-400">{r.student_email || r.requester_email || r.student_ou}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-500 max-w-xs">
                    <span className="line-clamp-2">{r.reason || <span className="italic text-slate-300">No reason given</span>}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
                    {new Date(r.requested_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[r.status]}`}>
                      {r.status}
                    </span>
                    {r.review_note && (
                      <div className="text-xs text-slate-400 mt-0.5 max-w-xs">{r.review_note}</div>
                    )}
                  </td>
                  {statusFilter === 'pending' && (
                    <td className="px-4 py-3">
                      <div className="flex gap-2 justify-end">
                        <button
                          className="text-xs px-2.5 py-1.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-40"
                          onClick={() => approve.mutate(r.id)}
                          disabled={approve.isPending}
                          title="Mark approved (no code)"
                        >
                          Approve
                        </button>
                        <button
                          className="text-xs px-2.5 py-1.5 rounded-lg bg-primary-600 text-white font-medium hover:bg-primary-700"
                          onClick={() => setModal({ type: 'override', request: r })}
                          title="Generate a temporary override code"
                        >
                          + Code
                        </button>
                        <button
                          className="text-xs px-2.5 py-1.5 rounded-lg border border-red-200 text-red-600 font-medium hover:bg-red-50"
                          onClick={() => setModal({ type: 'deny', request: r })}
                        >
                          Deny
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {total > requests.length && (
            <div className="px-4 py-3 text-xs text-slate-400 border-t border-slate-100">
              Showing {requests.length} of {total}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {modal?.type === 'override' && (
        <OverrideCodeModal request={modal.request} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'deny' && (
        <DenyModal request={modal.request} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
