import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import {
  mdiWrench,
  mdiPlus,
  mdiTrashCanOutline,
  mdiRefresh,
  mdiAlertCircle,
  mdiCheckCircle,
} from '@mdi/js';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Shared helpers
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
  open: 'Open', in_progress: 'In Progress', pending_approval: 'Pending Approval',
  approved: 'Approved', rejected: 'Rejected', closed: 'Closed',
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

// ---------------------------------------------------------------------------
// Tab 1: Tech Lab Classes
// ---------------------------------------------------------------------------
function ClassesTab() {
  const qc = useQueryClient();

  const { data: classes = [], isLoading } = useQuery({
    queryKey: ['techlab-admin-classes'],
    queryFn:  () => api.get('/tech-lab/admin/classes'),
  });

  const { data: availableClasses = [] } = useQuery({
    queryKey:  ['all-classes-for-techlab'],
    queryFn:   () => api.get('/classes'),
    staleTime: 60_000,
  });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    class_id:              '',
    oneroster_course_code: '',
    display_name:          '',
    auto_assign:           false,
  });
  const [formError, setFormError] = useState('');

  const addMutation = useMutation({
    mutationFn: (body) => api.post('/tech-lab/admin/classes', body),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['techlab-admin-classes'] });
      setShowForm(false);
      setForm({ class_id: '', oneroster_course_code: '', display_name: '', auto_assign: false });
      setFormError('');
    },
    onError: (err) => setFormError(err.message || 'Failed to add class'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.delete(`/tech-lab/admin/classes/${id}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['techlab-admin-classes'] }),
  });

  const toggleAutoAssignMutation = useMutation({
    mutationFn: ({ id, auto_assign }) => api.put(`/tech-lab/admin/classes/${id}`, { auto_assign }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['techlab-admin-classes'] }),
  });

  const handleAdd = () => {
    if (!form.class_id && !form.oneroster_course_code) {
      setFormError('Select an existing class or enter a OneRoster course code');
      return;
    }
    addMutation.mutate({
      class_id:              form.class_id              || undefined,
      oneroster_course_code: form.oneroster_course_code || undefined,
      display_name:          form.display_name          || undefined,
      auto_assign:           form.auto_assign,
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-slate-800">Designated Tech Lab Classes</h2>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowForm(s => !s)}
        >
          <MdiIcon path={mdiPlus} size="1em" />
          Add Class
        </button>
      </div>

      {/* Add-class form */}
      {showForm && (
        <div className="card p-5 mb-5 space-y-4">
          <h3 className="font-semibold text-slate-700 text-sm">Add Tech Lab Class</h3>

          {formError && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {formError}
            </div>
          )}

          <div>
            <label className="label">Pick from Existing Classes</label>
            <select
              className="input"
              value={form.class_id}
              onChange={e => setForm(f => ({ ...f, class_id: e.target.value }))}
            >
              <option value="">— Select a class —</option>
              {availableClasses.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name || c.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <div className="flex-1 border-t border-slate-200" />
            <span>or</span>
            <div className="flex-1 border-t border-slate-200" />
          </div>

          <div>
            <label className="label">OneRoster Course Code</label>
            <input
              type="text"
              className="input"
              placeholder="e.g. TECH-101"
              value={form.oneroster_course_code}
              onChange={e => setForm(f => ({ ...f, oneroster_course_code: e.target.value }))}
            />
          </div>

          <div>
            <label className="label">Display Name (optional)</label>
            <input
              type="text"
              className="input"
              placeholder="e.g. Chromebook Tech Lab — Period 2"
              value={form.display_name}
              onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.auto_assign}
              onChange={e => setForm(f => ({ ...f, auto_assign: e.target.checked }))}
            />
            Auto-assign <code className="text-xs bg-slate-100 px-1 rounded">student_technician</code> role to enrolled students
          </label>

          <div className="flex gap-2">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleAdd}
              disabled={addMutation.isPending}
            >
              {addMutation.isPending ? 'Adding…' : 'Add Class'}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => { setShowForm(false); setFormError(''); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Classes table */}
      {isLoading ? (
        <div className="card p-8 text-center text-slate-400 text-sm">Loading…</div>
      ) : classes.length === 0 ? (
        <div className="card p-10 text-center text-slate-400 text-sm">
          No Tech Lab classes configured yet.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Class</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Course Code</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Instructor</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Students</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Auto-Assign</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {classes.map(cls => (
                  <tr key={cls.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-800">
                      {cls.display_name || cls.name || '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-500 font-mono text-xs">
                      {cls.oneroster_course_code || '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-500">{cls.instructor_name || '—'}</td>
                    <td className="px-4 py-3 text-center text-slate-700">{cls.student_count ?? '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={cls.auto_assign || false}
                        onChange={e =>
                          toggleAutoAssignMutation.mutate({ id: cls.id, auto_assign: e.target.checked })
                        }
                        className="cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        className="btn btn-sm btn-secondary text-red-600 hover:text-red-700"
                        title="Remove class"
                        onClick={() => {
                          if (window.confirm('Remove this Tech Lab class?')) {
                            deleteMutation.mutate(cls.id);
                          }
                        }}
                        disabled={deleteMutation.isPending}
                      >
                        <MdiIcon path={mdiTrashCanOutline} size="1em" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: All Tickets (audit)
// ---------------------------------------------------------------------------
function TicketsTab() {
  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['techlab-admin-tickets'],
    queryFn:  () => api.get('/tech-lab/admin/tickets'),
  });

  return (
    <div>
      <h2 className="font-semibold text-slate-800 mb-4">All Tickets — Audit View</h2>

      {isLoading ? (
        <div className="card p-8 text-center text-slate-400 text-sm">Loading…</div>
      ) : tickets.length === 0 ? (
        <div className="card p-10 text-center text-slate-400 text-sm">No tickets yet.</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">#</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Student</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Device</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tickets.map(ticket => (
                  <tr key={ticket.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs">{ticket.id}</td>
                    <td className="px-4 py-3 font-medium text-slate-800">{ticket.title}</td>
                    <td className="px-4 py-3 text-slate-500">{ticket.student_name || '—'}</td>
                    <td className="px-4 py-3 text-slate-500">
                      <div>{ticket.device_name || ticket.device_serial || '—'}</div>
                      {ticket.device_serial && ticket.device_name && (
                        <div className="text-xs text-slate-400 font-mono">{ticket.device_serial}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={ticket.status} />
                    </td>
                    <td className="px-4 py-3 text-slate-400">{fmtDate(ticket.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: Assign Roles
// ---------------------------------------------------------------------------
function AssignRolesTab() {
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState('');

  const assignMutation = useMutation({
    mutationFn: () => api.post('/tech-lab/admin/assign-roles'),
    onSuccess:  (data) => { setResult(data); setRunError(''); },
    onError:    (err)  => { setRunError(err.message || 'Role assignment failed'); setResult(null); },
  });

  return (
    <div className="max-w-lg">
      <h2 className="font-semibold text-slate-800 mb-2">Assign Student Technician Roles</h2>
      <p className="text-sm text-slate-500 mb-5">
        Manually trigger role assignment for students enrolled in the configured Tech Lab
        classes. This also runs automatically on a schedule — use this button to run it
        immediately after making changes.
      </p>

      <button
        className="btn btn-primary"
        onClick={() => assignMutation.mutate()}
        disabled={assignMutation.isPending}
      >
        <MdiIcon path={mdiRefresh} size="1em" />
        {assignMutation.isPending ? 'Running…' : 'Run Role Assignment Now'}
      </button>

      {runError && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-2 text-sm text-red-700">
          <MdiIcon path={mdiAlertCircle} size="1.1em" className="flex-shrink-0 mt-0.5" />
          <span>{runError}</span>
        </div>
      )}

      {result && (
        <div className="mt-4 bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-800">
          <div className="flex items-center gap-2 font-semibold mb-2">
            <MdiIcon path={mdiCheckCircle} size="1.1em" />
            Role assignment complete
          </div>
          {result.assigned !== undefined && (
            <div>
              {result.assigned} student{result.assigned !== 1 ? 's' : ''} assigned the{' '}
              <code className="bg-green-100 px-1 rounded text-xs">student_technician</code> role.
            </div>
          )}
          {result.removed !== undefined && (
            <div>
              {result.removed} student{result.removed !== 1 ? 's' : ''} had the role removed
              (no longer enrolled in a Tech Lab class).
            </div>
          )}
          {result.message && (
            <div className="mt-1 text-green-700">{result.message}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = [
  { id: 'classes',      label: 'Tech Lab Classes' },
  { id: 'tickets',      label: 'All Tickets'      },
  { id: 'assign-roles', label: 'Assign Roles'     },
];

export default function AdminTechLab() {
  const [activeTab, setActiveTab] = useState('classes');

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <MdiIcon path={mdiWrench} size="1.2em" className="text-primary-600" />
          Tech Lab Administration
        </h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Manage Tech Lab classes, review all tickets, and control role assignment
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'classes'      && <ClassesTab />}
      {activeTab === 'tickets'      && <TicketsTab />}
      {activeTab === 'assign-roles' && <AssignRolesTab />}
    </div>
  );
}
