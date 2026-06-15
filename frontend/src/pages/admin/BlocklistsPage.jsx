import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

export default function BlocklistsPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', url: '' });
  const [syncing, setSyncing] = useState(null);
  const [policySearch, setPolicySearch] = useState('');
  const [attachTarget, setAttachTarget] = useState(null);

  const { data: blData, isLoading } = useQuery({
    queryKey: ['blocklists'],
    queryFn:  () => api.get('/blocklists'),
  });
  const blocklists = blData?.sources || [];

  const { data: policies = [] } = useQuery({
    queryKey: ['policies'],
    queryFn:  () => api.get('/policies'),
    enabled:  !!attachTarget,
  });

  const create = useMutation({
    mutationFn: () => api.post('/blocklists', { name: form.name, url: form.url, category: 'custom' }),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['blocklists'] }); setCreating(false); setForm({ name: '', description: '', url: '' }); },
  });

  const toggle = useMutation({
    mutationFn: ({ id, is_active }) => api.put(`/blocklists/${id}`, { is_active }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['blocklists'] }),
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/blocklists/${id}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['blocklists'] }),
  });

  const sync = useMutation({
    mutationFn: id => { setSyncing(id); return api.post(`/blocklists/${id}/sync`); },
    onSuccess:  () => { setSyncing(null); qc.invalidateQueries({ queryKey: ['blocklists'] }); },
    onError:    () => setSyncing(null),
  });

  const attachToPolicy = useMutation({
    mutationFn: ({ policyId, blocklistId }) => api.post(`/policies/${policyId}/blocklists`, { blocklist_id: blocklistId }),
    onSuccess:  () => { setAttachTarget(null); qc.invalidateQueries({ queryKey: ['policies'] }); },
  });

  const filtered = policies.filter(p =>
    !policySearch || p.name.toLowerCase().includes(policySearch.toLowerCase())
  );

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Blocklists</h1>
          <p className="text-slate-500 text-sm mt-0.5">URL-based domain blocklists (e.g. Steven Black hosts, OISD)</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ Add Blocklist</button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : (
        <div className="space-y-3">
          {blocklists.map(bl => (
            <div key={bl.id} className="card p-5">
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-semibold text-slate-900">{bl.name}</span>
                    {bl.is_active
                      ? <span className="badge-green text-xs">Active</span>
                      : <span className="badge-slate text-xs">Disabled</span>}
                    {bl.domain_count != null && (
                      <span className="text-xs text-slate-400">{bl.domain_count.toLocaleString()} domains</span>
                    )}
                  </div>
                  {bl.description && <div className="text-sm text-slate-500 mb-1">{bl.description}</div>}
                  {bl.url && (
                    <div className="font-mono text-xs text-slate-400 truncate">{bl.url}</div>
                  )}
                  {bl.last_synced_at && (
                    <div className="text-xs text-slate-400 mt-1">
                      Last synced {new Date(bl.last_synced_at).toLocaleString()}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {bl.url && (
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => sync.mutate(bl.id)}
                      disabled={syncing === bl.id}
                    >
                      {syncing === bl.id ? 'Syncing…' : 'Sync'}
                    </button>
                  )}
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => setAttachTarget(bl)}
                  >
                    Assign
                  </button>
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => toggle.mutate({ id: bl.id, is_active: !bl.is_active })}
                  >
                    {bl.is_active ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="text-xs text-slate-400 hover:text-red-500 px-2 py-1.5"
                    onClick={() => { if (confirm(`Delete "${bl.name}"?`)) del.mutate(bl.id); }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}

          {blocklists.length === 0 && (
            <div className="card p-10 text-center text-slate-400 text-sm">
              No blocklists configured. Add your first one to get started.
            </div>
          )}
        </div>
      )}

      {/* Create modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <h2 className="font-semibold text-slate-900 mb-4">Add Blocklist</h2>
            <div className="space-y-3 mb-5">
              <div>
                <label className="label">Name</label>
                <input className="input" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
              </div>
              <div>
                <label className="label">Source URL <span className="text-slate-400 font-normal">(hosts file format)</span></label>
                <input className="input font-mono text-sm" placeholder="https://…"
                  value={form.url}
                  onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
              </div>
              <div>
                <label className="label">Description <span className="text-slate-400 font-normal">(optional)</span></label>
                <input className="input" placeholder="e.g. Steven Black unified hosts"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </div>
              <p className="text-xs text-slate-400">Blocklist will be inactive until manually synced and enabled.</p>
            </div>
            <div className="flex gap-3 justify-end">
              <button className="btn-secondary" onClick={() => setCreating(false)}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!form.name || !form.url || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? 'Adding…' : 'Add Blocklist'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign to policy modal */}
      {attachTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <h2 className="font-semibold text-slate-900 mb-1">Assign "{attachTarget.name}"</h2>
            <p className="text-sm text-slate-500 mb-4">Choose a policy to attach this blocklist to</p>
            <input
              className="input mb-3"
              placeholder="Search policies…"
              value={policySearch}
              onChange={e => setPolicySearch(e.target.value)}
            />
            <div className="space-y-2 max-h-52 overflow-y-auto">
              {filtered.map(p => (
                <button
                  key={p.id}
                  className="w-full text-left px-4 py-3 rounded-lg border border-slate-200 hover:border-primary-400 hover:bg-primary-50 transition-colors"
                  onClick={() => attachToPolicy.mutate({ policyId: p.id, blocklistId: attachTarget.id })}
                >
                  <div className="font-medium text-sm text-slate-800">{p.name}</div>
                  {p.description && <div className="text-xs text-slate-400">{p.description}</div>}
                </button>
              ))}
              {filtered.length === 0 && <div className="text-slate-400 text-sm text-center py-4">No policies found</div>}
            </div>
            <div className="mt-4 pt-4 border-t border-slate-100">
              <button className="btn-secondary w-full" onClick={() => setAttachTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
