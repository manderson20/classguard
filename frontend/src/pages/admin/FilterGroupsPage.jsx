import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

function DefaultActionBadge({ action }) {
  if (action === 'block') {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
        Allowlist-only
      </span>
    );
  }
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
      Standard filter
    </span>
  );
}

export default function FilterGroupsPage() {
  const qc = useQueryClient();

  const [selected,     setSelected]     = useState(null);
  const [creating,     setCreating]     = useState(false);
  const [form,         setForm]         = useState({ name: '', description: '', policy_id: '' });
  const [studentQuery, setStudentQuery] = useState('');
  const [searchOpen,   setSearchOpen]   = useState(false);

  // Filter groups list
  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['filter-groups'],
    queryFn:  () => api.get('/filter-groups'),
  });

  // Detail for selected group
  const { data: groupDetail } = useQuery({
    queryKey: ['filter-group', selected],
    queryFn:  () => api.get(`/filter-groups/${selected}`),
    enabled:  !!selected,
  });

  // All policies for the assignment dropdown
  const { data: policies = [] } = useQuery({
    queryKey: ['policies-list'],
    queryFn:  () => api.get('/policies'),
    select:   data => data.policies || data,
  });

  // Student search
  const { data: studentResults = [] } = useQuery({
    queryKey: ['student-search', studentQuery],
    queryFn:  () => api.get('/users', { params: { search: studentQuery, role: 'student', limit: 10 } })
                        .then(d => d.users || d),
    enabled:  studentQuery.length >= 2,
  });

  const createGroup = useMutation({
    mutationFn: () => api.post('/filter-groups', {
      name:        form.name,
      description: form.description || null,
      policy_id:   form.policy_id   || null,
    }),
    onSuccess: data => {
      qc.invalidateQueries({ queryKey: ['filter-groups'] });
      setCreating(false);
      setForm({ name: '', description: '', policy_id: '' });
      setSelected(data.id);
    },
  });

  const deleteGroup = useMutation({
    mutationFn: id => api.delete(`/filter-groups/${id}`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['filter-groups'] });
      setSelected(null);
    },
  });

  const assignPolicy = useMutation({
    mutationFn: ({ groupId, policyId }) => api.put(`/filter-groups/${groupId}/policy`, { policy_id: policyId }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['filter-groups'] });
      qc.invalidateQueries({ queryKey: ['filter-group', selected] });
    },
  });

  const unassignPolicy = useMutation({
    mutationFn: groupId => api.delete(`/filter-groups/${groupId}/policy`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['filter-groups'] });
      qc.invalidateQueries({ queryKey: ['filter-group', selected] });
    },
  });

  const addMember = useMutation({
    mutationFn: ({ groupId, userId }) => api.post(`/filter-groups/${groupId}/members`, { user_id: userId }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['filter-group', selected] });
      qc.invalidateQueries({ queryKey: ['filter-groups'] });
      setStudentQuery('');
      setSearchOpen(false);
    },
  });

  const removeMember = useMutation({
    mutationFn: ({ groupId, userId }) => api.delete(`/filter-groups/${groupId}/members/${userId}`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['filter-group', selected] });
      qc.invalidateQueries({ queryKey: ['filter-groups'] });
    },
  });

  const group = groups.find(g => g.id === selected);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-slate-900">Filter Groups</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ New Filter Group</button>
      </div>
      <p className="text-sm text-slate-500 mb-6">
        Penalty-box-style groups for students who need more restrictive internet access.
        Each group has a dedicated filter policy assigned to it. Students added here are filtered
        by that policy regardless of their class or OU assignment.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Group list */}
        <div className="lg:col-span-1 space-y-2">
          {isLoading && <div className="text-slate-400 text-sm">Loading…</div>}
          {groups.map(g => (
            <button
              key={g.id}
              onClick={() => setSelected(g.id)}
              className={`w-full text-left p-4 rounded-xl border text-sm transition-colors
                ${selected === g.id
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'card border-transparent hover:border-slate-200'}`}
            >
              <div className="font-medium truncate">{g.name}</div>
              {g.policy_name ? (
                <div className={`text-xs mt-1 truncate ${selected === g.id ? 'text-primary-200' : 'text-slate-500'}`}>
                  {g.policy_name}
                  {g.policy_default_action === 'block' && (
                    <span className={`ml-1.5 ${selected === g.id ? 'text-primary-200' : 'text-orange-600'}`}>
                      · Allowlist-only
                    </span>
                  )}
                </div>
              ) : (
                <div className={`text-xs mt-1 italic ${selected === g.id ? 'text-primary-200' : 'text-amber-600'}`}>
                  No policy assigned
                </div>
              )}
              <div className={`text-xs mt-1 ${selected === g.id ? 'text-primary-200' : 'text-slate-400'}`}>
                {g.member_count ?? 0} student{Number(g.member_count) !== 1 ? 's' : ''}
              </div>
            </button>
          ))}
          {!isLoading && groups.length === 0 && (
            <div className="card p-6 text-center text-slate-400 text-sm">
              No filter groups yet.<br />Create one to start assigning restrictive policies.
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-2">
          {!selected && (
            <div className="card p-10 text-center text-slate-400 text-sm">
              Select a filter group to manage students and policy
            </div>
          )}

          {selected && group && (
            <div className="card p-5 space-y-5">
              {/* Header */}
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-semibold text-slate-900 text-lg">{group.name}</h2>
                  {group.description && (
                    <p className="text-sm text-slate-500 mt-0.5">{group.description}</p>
                  )}
                </div>
                <button
                  className="text-xs text-red-500 hover:underline flex-shrink-0 mt-1"
                  onClick={() => {
                    if (confirm(`Delete filter group "${group.name}"? Students will no longer be filtered by this group's policy.`)) {
                      deleteGroup.mutate(selected);
                    }
                  }}
                >
                  Delete group
                </button>
              </div>

              {/* Policy assignment */}
              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-slate-700">Filter Policy</h3>
                  {groupDetail?.policy_id && (
                    <button
                      className="text-xs text-slate-400 hover:text-red-500"
                      onClick={() => unassignPolicy.mutate(selected)}
                      disabled={unassignPolicy.isPending}
                    >
                      Remove policy
                    </button>
                  )}
                </div>

                {groupDetail?.policy_id ? (
                  <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">
                        {groupDetail.policy_name}
                      </div>
                      <DefaultActionBadge action={groupDetail.policy_default_action} />
                    </div>
                    <select
                      className="text-xs border border-slate-200 rounded px-2 py-1 text-slate-600 focus:outline-none focus:ring-1 focus:ring-primary-500"
                      value={groupDetail.policy_id}
                      onChange={e => assignPolicy.mutate({ groupId: selected, policyId: e.target.value })}
                      disabled={assignPolicy.isPending}
                    >
                      {policies.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="flex-1 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                      No policy assigned — students in this group use their normal policy.
                    </div>
                    <select
                      className="text-sm border border-slate-300 rounded-lg px-3 py-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      defaultValue=""
                      onChange={e => e.target.value && assignPolicy.mutate({ groupId: selected, policyId: e.target.value })}
                      disabled={assignPolicy.isPending}
                    >
                      <option value="" disabled>Assign policy…</option>
                      {policies.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Members */}
              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-700">
                    Students ({(groupDetail?.members || []).length})
                  </h3>
                  <button
                    className="text-xs text-primary-600 hover:underline font-medium"
                    onClick={() => setSearchOpen(s => !s)}
                  >
                    {searchOpen ? 'Cancel' : '+ Add Student'}
                  </button>
                </div>

                {/* Add student search */}
                {searchOpen && (
                  <div className="mb-4 relative">
                    <input
                      className="input w-full"
                      placeholder="Search by name or email…"
                      value={studentQuery}
                      onChange={e => setStudentQuery(e.target.value)}
                      autoFocus
                    />
                    {studentQuery.length >= 2 && (
                      <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {studentResults.length === 0 ? (
                          <div className="px-4 py-3 text-sm text-slate-400">No students found</div>
                        ) : (
                          studentResults.map(s => {
                            const alreadyMember = (groupDetail?.members || []).some(m => m.id === s.id);
                            return (
                              <button
                                key={s.id}
                                disabled={alreadyMember || addMember.isPending}
                                onClick={() => addMember.mutate({ groupId: selected, userId: s.id })}
                                className="w-full text-left px-4 py-2.5 hover:bg-slate-50 disabled:opacity-50 border-b border-slate-100 last:border-0"
                              >
                                <div className="text-sm font-medium text-slate-800">{s.full_name || s.email}</div>
                                <div className="text-xs text-slate-400">{s.email}{alreadyMember ? ' — already in group' : ''}</div>
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Member list */}
                {(groupDetail?.members || []).length === 0 ? (
                  <div className="text-slate-400 text-sm py-4 text-center">No students in this group</div>
                ) : (
                  <div className="space-y-1.5">
                    {(groupDetail?.members || []).map(m => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-50"
                      >
                        <div>
                          <div className="text-sm font-medium text-slate-800">{m.full_name || '—'}</div>
                          <div className="text-xs text-slate-400">{m.email}</div>
                        </div>
                        <button
                          className="text-xs text-slate-400 hover:text-red-500"
                          onClick={() => removeMember.mutate({ groupId: selected, userId: m.id })}
                          disabled={removeMember.isPending}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h2 className="font-semibold text-slate-900 mb-1">New Filter Group</h2>
            <p className="text-xs text-slate-500 mb-4">
              A named group for students needing extra internet restrictions. Assign a filter policy below.
            </p>
            <div className="space-y-3 mb-5">
              <div>
                <label className="label">Name</label>
                <input
                  className="input"
                  placeholder="e.g. Restricted Access — Tier 1"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  autoFocus
                />
              </div>
              <div>
                <label className="label">Description <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  className="input"
                  placeholder="e.g. Students with ongoing policy violations"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Filter Policy <span className="text-slate-400 font-normal">(optional, can assign later)</span></label>
                <select
                  className="input"
                  value={form.policy_id}
                  onChange={e => setForm(f => ({ ...f, policy_id: e.target.value }))}
                >
                  <option value="">— select policy —</option>
                  {policies.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button className="btn-secondary" onClick={() => setCreating(false)}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!form.name || createGroup.isPending}
                onClick={() => createGroup.mutate()}
              >
                {createGroup.isPending ? 'Creating…' : 'Create Group'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
