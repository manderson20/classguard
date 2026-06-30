import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

function GroupSourceBadge({ groupType }) {
  if (groupType === 'google') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
        Google Workspace
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
      ClassGuard
    </span>
  );
}

export default function GroupsPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ name: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [memberEmail, setMemberEmail] = useState('');

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['groups'],
    queryFn:  () => api.get('/groups'),
  });

  const { data: groupDetail } = useQuery({
    queryKey: ['group', selected],
    queryFn:  () => api.get(`/groups/${selected}`),
    enabled:  !!selected,
  });

  const createGroup = useMutation({
    mutationFn: () => api.post('/groups', form),
    onSuccess:  data => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      setCreating(false);
      setForm({ name: '', description: '' });
      setSelected(data.id);
    },
  });

  const deleteGroup = useMutation({
    mutationFn: id => api.delete(`/groups/${id}`),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['groups'] }); setSelected(null); },
  });

  const addMember = useMutation({
    mutationFn: ({ groupId, email }) => api.post(`/groups/${groupId}/members`, { email }),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['group', selected] }); setMemberEmail(''); },
  });

  const removeMember = useMutation({
    mutationFn: ({ groupId, userId }) => api.delete(`/groups/${groupId}/members/${userId}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['group', selected] }),
  });

  const group = groups.find(g => g.id === selected);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-slate-900">Groups</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ New Group</button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Organizational groups for policy assignment — both Google Workspace groups (synced, read-only here) and
        manually created ClassGuard groups. For filter/penalty groups assigned to students needing extra
        restrictions, use <a href="/admin/filter-groups" className="text-primary-600 hover:underline">Filter Groups</a>.
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
              <div className="flex items-center gap-2 mb-0.5">
                <span className="font-medium truncate">{g.name}</span>
                {selected !== g.id && <GroupSourceBadge groupType={g.group_type} />}
              </div>
              {g.description && (
                <div className={`text-xs mt-0.5 truncate ${selected === g.id ? 'text-primary-200' : 'text-slate-400'}`}>
                  {g.description}
                </div>
              )}
              <div className={`text-xs mt-1 ${selected === g.id ? 'text-primary-200' : 'text-slate-400'}`}>
                {g.member_count ?? 0} members
              </div>
            </button>
          ))}
          {!isLoading && groups.length === 0 && (
            <div className="text-slate-400 text-sm text-center py-6">No groups yet</div>
          )}
        </div>

        {/* Group detail */}
        <div className="lg:col-span-2">
          {!selected && (
            <div className="card p-10 text-center text-slate-400 text-sm">Select a group to manage its members</div>
          )}

          {selected && (
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-slate-900">{group?.name}</h2>
                <button
                  className="text-xs text-red-500 hover:underline"
                  onClick={() => { if (confirm('Delete this group?')) deleteGroup.mutate(selected); }}
                >
                  Delete group
                </button>
              </div>

              {/* Add member */}
              <div className="flex gap-2 mb-5">
                <input
                  className="input flex-1"
                  placeholder="student@school.edu"
                  value={memberEmail}
                  onChange={e => setMemberEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && memberEmail && addMember.mutate({ groupId: selected, email: memberEmail })}
                />
                <button
                  className="btn-primary flex-shrink-0"
                  disabled={!memberEmail || addMember.isPending}
                  onClick={() => addMember.mutate({ groupId: selected, email: memberEmail })}
                >
                  Add Member
                </button>
              </div>

              {/* Members table */}
              {(groupDetail?.members || []).length === 0 ? (
                <div className="text-slate-400 text-sm py-4 text-center">No members in this group</div>
              ) : (
                <div className="space-y-1.5">
                  {(groupDetail?.members || []).map(m => (
                    <div key={m.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-50">
                      <div>
                        <div className="text-sm font-medium text-slate-800">{m.full_name || '—'}</div>
                        <div className="text-xs text-slate-400">{m.email}</div>
                      </div>
                      <button
                        className="text-xs text-slate-400 hover:text-red-500"
                        onClick={() => removeMember.mutate({ groupId: selected, userId: m.id })}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h2 className="font-semibold text-slate-900 mb-4">Create Group</h2>
            <div className="space-y-3 mb-5">
              <div>
                <label className="label">Name</label>
                <input className="input" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
              </div>
              <div>
                <label className="label">Description</label>
                <input className="input" placeholder="Optional" value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button className="btn-secondary" onClick={() => setCreating(false)}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!form.name || createGroup.isPending}
                onClick={() => createGroup.mutate()}
              >
                {createGroup.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
