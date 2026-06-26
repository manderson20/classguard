import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import { mdiAccountGroup, mdiAlertCircle } from '@mdi/js';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../lib/api';

export default function TechLabStudents() {
  const { user } = useAuth();
  const navigate  = useNavigate();

  const isTechInstructor = user?.is_tech_instructor === true;
  const isAdmin          = ['admin', 'superadmin'].includes(user?.role);
  const canAccess        = isTechInstructor || isAdmin;

  // Hooks before any early return
  const { data: students = [], isLoading } = useQuery({
    queryKey:  ['techlab-instructor-students'],
    queryFn:   () => api.get('/tech-lab/instructor/students'),
    enabled:   canAccess,
    staleTime: 60_000,
  });

  if (!canAccess) return <Navigate to="/techlab" replace />;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <MdiIcon path={mdiAccountGroup} size="1.2em" className="text-primary-600" />
          Student Roster
        </h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Tech Lab students and their ticket statistics
        </p>
      </div>

      {isLoading ? (
        <div className="card p-8 text-center text-slate-400 text-sm">Loading students…</div>
      ) : students.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-slate-400 text-sm">
            No students enrolled in your Tech Lab class yet.
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    Student
                  </th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    Total
                  </th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    Open
                  </th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    Closed
                  </th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    Pending
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {students.map(student => (
                  <tr
                    key={student.id}
                    className="hover:bg-slate-50 cursor-pointer transition-colors"
                    onClick={() => navigate(`/techlab?student=${student.id}`)}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{student.full_name}</div>
                      <div className="text-xs text-slate-400">{student.email}</div>
                    </td>
                    <td className="px-4 py-3 text-center font-semibold text-slate-700">
                      {student.total_tickets ?? 0}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`font-semibold ${
                          student.open_tickets > 0 ? 'text-blue-600' : 'text-slate-300'
                        }`}
                      >
                        {student.open_tickets ?? 0}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`font-semibold ${
                          student.closed_tickets > 0 ? 'text-green-600' : 'text-slate-300'
                        }`}
                      >
                        {student.closed_tickets ?? 0}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {student.pending_approvals > 0 ? (
                        <span className="inline-flex items-center gap-1 text-orange-600 font-semibold">
                          <MdiIcon path={mdiAlertCircle} size="0.9em" />
                          {student.pending_approvals}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
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
