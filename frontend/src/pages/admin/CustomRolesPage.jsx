import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

export default function CustomRolesPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ name: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [checked, setChecked] = useState(new Set());

  const { data: catalog = [] } = useQuery({
    queryKey: ['custom-roles-catalog'],
    queryFn:  () => api.get('/custom-roles/catalog'),
  });

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['custom-roles'],
    queryFn:  () => api.get('/custom-roles'),
  });

  const { data: roleDetail } = useQuery({
    queryKey: ['custom-role', selected],
    queryFn:  () => api.get(`/custom-roles/${selected}`),
    enabled:  !!selected,
  });

  useEffect(() => {
    setChecked(new Set(roleDetail?.permissions || []));
  }, [roleDetail]);

  const createRole = useMutation({
    mutationFn: () => api.post('/custom-roles', form),
    onSuccess:  data => {
      qc.invalidateQueries({ queryKey: ['custom-roles'] });
      setCreating(false);
      setForm({ name: '', description: '' });
      setSelected(data.id);
    },
  });

  const deleteRole = useMutation({
    mutationFn: id => api.delete(`/custom-roles/${id}`),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['custom-roles'] }); setSelected(null); },
  });

  const savePermissions = useMutation({
    mutationFn: () => api.put(`/custom-roles/${selected}/permissions`, { permissions: [...checked] }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['custom-role', selected] });
      qc.invalidateQueries({ queryKey: ['custom-roles'] });
    },
  });

  const role = roles.find(r => r.id === selected);

  const sections = catalog.reduce((acc, p) => {
    (acc[p.section] ||= []).push(p);
    return acc;
  }, {});

  const toggle = key => setChecked(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-slate-900">Roles &amp; Permissions</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ New Role</button>
      </div>
      <p className="text-sm text-slate-500 mb-6">
        Restrict an admin-tier staff member to just the feature areas they need. A user with no
        custom role assigned keeps full, unrestricted admin access — exactly as today.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Role list */}
        <div className="lg:col-span-1 space-y-2">
          {isLoading && <div className="text-slate-400 text-sm">Loading…</div>}
          {roles.map(r => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={`w-full text-left p-4 rounded-xl border text-sm transition-colors
                ${selected === r.id
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'card border-transparent hover:border-slate-200'}`}
            >
              <div className="font-medium">{r.name}</div>
              {r.description && (
                <div className={`text-xs mt-0.5 truncate ${selected === r.id ? 'text-primary-200' : 'text-slate-400'}`}>
                  {r.description}
                </div>
              )}
              <div className={`text-xs mt-1 ${selected === r.id ? 'text-primary-200' : 'text-slate-400'}`}>
                {r.user_count ?? 0} user{r.user_count === 1 ? '' : 's'}
              </div>
            </button>
          ))}
          {!isLoading && roles.length === 0 && (
            <div className="text-slate-400 text-sm text-center py-6">No custom roles yet</div>
          )}
        </div>

        {/* Role detail */}
        <div className="lg:col-span-2">
          {!selected && (
            <div className="card p-10 text-center text-slate-400 text-sm">
              Select a role to edit its permissions
            </div>
          )}

          {selected && (
            <div className="card p-5">
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-semibold text-slate-900">{role?.name}</h2>
                <button
                  className="text-xs text-red-500 hover:underline"
                  onClick={() => { if (confirm('Delete this role? Any assigned users become unrestricted.')) deleteRole.mutate(selected); }}
                >
                  Delete role
                </button>
              </div>
              {role?.description && <div className="text-xs text-slate-400 mb-4">{role.description}</div>}

              {(roleDetail?.users || []).length > 0 && (
                <div className="text-xs text-slate-500 mb-4">
                  Assigned to: {roleDetail.users.map(u => u.full_name || u.email).join(', ')}
                </div>
              )}

              <div className="space-y-5 mb-5">
                {Object.entries(sections).map(([section, perms]) => (
                  <div key={section}>
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">{section}</div>
                    <div className="grid grid-cols-2 gap-2">
                      {perms.map(p => (
                        <label
                          key={p.key}
                          className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border cursor-pointer
                            ${checked.has(p.key) ? 'border-primary-300 bg-primary-50' : 'border-slate-200'}
                            ${p.sensitive ? 'ring-1 ring-amber-200' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked.has(p.key)}
                            onChange={() => toggle(p.key)}
                          />
                          <span>{p.label}</span>
                          {p.sensitive && <span className="text-amber-600 text-xs ml-auto">contains secrets</span>}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-end">
                <button
                  className="btn-primary"
                  disabled={savePermissions.isPending}
                  onClick={() => savePermissions.mutate()}
                >
                  {savePermissions.isPending ? 'Saving…' : 'Save Permissions'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h2 className="font-semibold text-slate-900 mb-4">Create Role</h2>
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
                disabled={!form.name || createRole.isPending}
                onClick={() => createRole.mutate()}
              >
                {createRole.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
