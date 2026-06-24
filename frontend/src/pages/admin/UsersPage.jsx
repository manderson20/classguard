import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import Avatar from '../../components/Avatar';
import AddUserModal from '../../components/admin/AddUserModal';
import { roleOptionsFromCustomRoles, decodeRoleValue, encodeRoleValue } from '../../lib/roleOptions';

const ROLE_BADGE = {
  student:    'badge-slate',
  teacher:    'badge-blue',
  admin:      'badge-purple',
  superadmin: 'bg-yellow-100 text-yellow-800 text-xs font-semibold px-2 py-0.5 rounded-full',
};

const ROLES = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

const PAGE_SIZE = 50;

export default function UsersPage() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [page, setPage] = useState(0);

  // Reset to page 1 whenever a filter changes -- otherwise e.g. typing a
  // search while sitting on page 5 of the unfiltered list shows "no
  // results" instead of the actual (much shorter) filtered first page.
  const handleSearch = (v) => { setSearch(v); setPage(0); };
  const handleRoleFilter = (v) => { setRoleFilter(v); setPage(0); };

  const { data, isLoading } = useQuery({
    queryKey: ['users', search, roleFilter, page],
    queryFn:  () => {
      const p = new URLSearchParams();
      if (search)     p.set('search', search);
      if (roleFilter) p.set('role', roleFilter);
      p.set('limit', PAGE_SIZE);
      p.set('offset', page * PAGE_SIZE);
      return api.get(`/users?${p}`);
    },
    keepPreviousData: true,
  });
  const users = data?.users || [];
  const total = data?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setRole = useMutation({
    mutationFn: ({ userId, roleValue }) => api.put(`/users/${userId}/role`, decodeRoleValue(roleValue)),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const isSuperAdmin = (ROLES[me?.role] ?? 0) >= ROLES.superadmin;

  const { data: customRoles = [] } = useQuery({
    queryKey: ['custom-roles'],
    queryFn:  () => api.get('/custom-roles'),
    enabled:  isSuperAdmin,
  });
  const roleOptions = roleOptionsFromCustomRoles(customRoles);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Users</h1>
        <div className="flex items-center gap-4">
          <span className="text-slate-400 text-sm">{total.toLocaleString()} users</span>
          {isSuperAdmin && (
            <button className="btn-primary text-sm" onClick={() => setAddOpen(true)}>
              + Add Local User
            </button>
          )}
        </div>
      </div>

      {addOpen && <AddUserModal onClose={() => setAddOpen(false)} />}

      {/* Filters */}
      <div className="flex gap-3 mb-5">
        <input
          className="input flex-1 max-w-xs"
          placeholder="Search name or email…"
          value={search}
          onChange={e => handleSearch(e.target.value)}
        />
        <select className="input w-36" value={roleFilter} onChange={e => handleRoleFilter(e.target.value)}>
          <option value="">All roles</option>
          <option value="student">Student</option>
          <option value="teacher">Teacher</option>
          <option value="admin">Admin</option>
          <option value="superadmin">Superadmin</option>
        </select>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">User</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">OU</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Role</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Policy</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400 text-sm">Loading…</td></tr>
            )}
            {!isLoading && users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400 text-sm">No users found</td></tr>
            )}
            {users.map(u => (
              <tr key={u.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Avatar photoUrl={u.photo_url} name={u.full_name} email={u.email} />
                    <div>
                      <div className="font-medium text-slate-800">{u.full_name || '—'}</div>
                      <div className="text-xs text-slate-400">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-slate-500 font-mono max-w-[180px] truncate">{u.google_ou || '—'}</td>
                <td className="px-4 py-3">
                  {isSuperAdmin && u.id !== me?.id ? (
                    <select
                      className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white focus:ring-1 focus:ring-primary-500 focus:outline-none"
                      value={encodeRoleValue(u, customRoles)}
                      onChange={e => setRole.mutate({ userId: u.id, roleValue: e.target.value })}
                    >
                      {roleOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <span className={ROLE_BADGE[u.role] || 'badge-slate'}>{u.role}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">{u.effective_policy_name || '—'}</td>
                <td className="px-4 py-3 text-right">
                  <Link to={`/admin/users/${u.id}`} className="text-xs text-primary-600 hover:underline">
                    View →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <span className="text-slate-400">
            Page {page + 1} of {pageCount.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <button
              className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              ← Previous
            </button>
            <button
              className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40"
              onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
