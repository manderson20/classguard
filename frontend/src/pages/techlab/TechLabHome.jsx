import { useState } from 'react';
import { Navigate, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import { mdiWrench, mdiPlus, mdiAlertCircle, mdiAccountGroup } from '@mdi/js';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../lib/api';

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

function StatusBadge({ status }) {
  return (
    <span className={STATUS_BADGE[status] || 'badge badge-slate'}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

const STATUS_TABS = ['all', 'open', 'in_progress', 'pending_approval', 'closed'];
const TAB_LABELS  = {
  all:              'All',
  open:             'Open',
  in_progress:      'In Progress',
  pending_approval: 'Pending Approval',
  closed:           'Closed',
};

export default function TechLabHome() {
  const { user } = useAuth();
  const navigate  = useNavigate();

  const isAdmin          = ['admin', 'superadmin'].includes(user?.role);
  const isTechInstructor = user?.is_tech_instructor === true;
  const isStudentTech    = user?.role === 'student_technician';

  // All hooks before any early return
  const [activeTab, setActiveTab] = useState('all');

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['techlab-tickets'],
    queryFn:  () => api.get('/tech-lab/tickets'),
    enabled:  !isAdmin, // skip if we're about to redirect admins
  });

  const { data: students = [] } = useQuery({
    queryKey:  ['techlab-instructor-students'],
    queryFn:   () => api.get('/tech-lab/instructor/students'),
    enabled:   isTechInstructor,
    staleTime: 60_000,
  });

  const { data: approvals = [] } = useQuery({
    queryKey:        ['techlab-approvals'],
    queryFn:         () => api.get('/tech-lab/instructor/approvals'),
    enabled:         isTechInstructor,
    refetchInterval: 30_000,
  });

  // Admins go straight to the admin audit view
  if (isAdmin) return <Navigate to="/admin/tech-lab" replace />;

  const filteredTickets = activeTab === 'all'
    ? tickets
    : tickets.filter(t => t.status === activeTab);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <MdiIcon path={mdiWrench} size="1.2em" className="text-primary-600" />
            Tech Lab
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {isStudentTech ? 'Your repair tickets' : 'Class repair tickets'}
          </p>
        </div>
        {isStudentTech && (
          <button
            className="btn btn-primary"
            onClick={() => navigate('/techlab/new')}
          >
            <MdiIcon path={mdiPlus} size="1em" />
            New Ticket
          </button>
        )}
      </div>

      {/* Instructor: pending approvals alert */}
      {isTechInstructor && approvals.length > 0 && (
        <div className="mb-4 bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <MdiIcon path={mdiAlertCircle} size="1.1em" className="text-orange-500 flex-shrink-0" />
            <span className="font-semibold text-orange-800 text-sm">
              {approvals.length} pending approval{approvals.length !== 1 ? 's' : ''} need{approvals.length === 1 ? 's' : ''} your review
            </span>
          </div>
          <Link
            to="/techlab/approvals"
            className="btn btn-sm bg-orange-500 text-white hover:bg-orange-600 focus:ring-orange-400 flex-shrink-0"
          >
            Review Approvals
          </Link>
        </div>
      )}

      {/* Instructor: student roster summary card */}
      {isTechInstructor && students.length > 0 && (
        <div className="card p-4 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <MdiIcon path={mdiAccountGroup} size="1em" className="text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-700">Student Roster</h2>
            <Link to="/techlab/students" className="ml-auto text-xs text-primary-600 hover:underline">
              View all →
            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div>
              <div className="text-2xl font-bold text-slate-800">{students.length}</div>
              <div className="text-xs text-slate-500">Students</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-blue-600">
                {students.reduce((sum, s) => sum + (s.open_tickets || 0), 0)}
              </div>
              <div className="text-xs text-slate-500">Open Tickets</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-green-600">
                {students.reduce((sum, s) => sum + (s.closed_tickets || 0), 0)}
              </div>
              <div className="text-xs text-slate-500">Completed</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-orange-500">
                {students.reduce((sum, s) => sum + (s.pending_approvals || 0), 0)}
              </div>
              <div className="text-xs text-slate-500">Pending</div>
            </div>
          </div>
        </div>
      )}

      {/* Status tabs — instructor only */}
      {isTechInstructor && (
        <div className="flex gap-1 mb-4 bg-slate-100 rounded-lg p-1 w-fit flex-wrap">
          {STATUS_TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                activeTab === tab
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {TAB_LABELS[tab]}
              {tab !== 'all' && tickets.filter(t => t.status === tab).length > 0 && (
                <span className="ml-1.5 bg-slate-200 text-slate-600 text-[10px] rounded-full px-1.5 py-0.5">
                  {tickets.filter(t => t.status === tab).length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Tickets table */}
      <div className="card">
        {isLoading ? (
          <div className="p-8 text-center text-slate-400 text-sm">Loading tickets…</div>
        ) : filteredTickets.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">
            {isStudentTech
              ? 'No tickets yet. Click "New Ticket" to get started.'
              : activeTab === 'all'
                ? 'No tickets in this class yet.'
                : `No tickets with status "${TAB_LABELS[activeTab]}".`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Device</th>
                  {isTechInstructor && (
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Student</th>
                  )}
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTickets.map(ticket => (
                  <tr
                    key={ticket.id}
                    className="hover:bg-slate-50 cursor-pointer transition-colors"
                    onClick={() => navigate(`/techlab/tickets/${ticket.id}`)}
                  >
                    <td className="px-4 py-3 font-medium text-slate-800">{ticket.title}</td>
                    <td className="px-4 py-3 text-slate-500">
                      <div>{ticket.device_name || ticket.device_serial || '—'}</div>
                      {ticket.device_serial && ticket.device_name && (
                        <div className="text-xs text-slate-400 font-mono">{ticket.device_serial}</div>
                      )}
                    </td>
                    {isTechInstructor && (
                      <td className="px-4 py-3 text-slate-500">{ticket.student_name || '—'}</td>
                    )}
                    <td className="px-4 py-3">
                      <StatusBadge status={ticket.status} />
                    </td>
                    <td className="px-4 py-3 text-slate-400">{fmtDate(ticket.created_at)}</td>
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
