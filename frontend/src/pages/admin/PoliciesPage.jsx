import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

export default function PoliciesPage() {
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(null);

  const { data: policies = [], isLoading } = useQuery({
    queryKey: ['policies'],
    queryFn:  () => api.get('/policies'),
  });

  const clone = useMutation({
    mutationFn: id => api.post(`/policies/${id}/clone`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['policies'] }),
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/policies/${id}`),
    onSuccess:  () => { setDeleting(null); qc.invalidateQueries({ queryKey: ['policies'] }); },
  });

  const createDefault = useMutation({
    mutationFn: () => api.post('/policies', {
      name: 'New Policy',
      description: '',
      mode: 'standard',
      is_default: false,
    }),
    onSuccess: data => qc.invalidateQueries({ queryKey: ['policies'] }),
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Policies</h1>
        <button className="btn-primary" onClick={() => createDefault.mutate()}>
          + New Policy
        </button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : (
        <div className="space-y-3">
          {policies.map(p => (
            <div key={p.id} className="card p-5 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-semibold text-slate-900">{p.name}</span>
                  {p.is_default && <span className="badge-blue text-xs">Default</span>}
                  <span className="badge-slate text-xs capitalize">{p.mode}</span>
                </div>
                {p.description && <div className="text-sm text-slate-500 truncate">{p.description}</div>}
                <div className="text-xs text-slate-400 mt-1">
                  {p.assignment_count ?? 0} assignment{p.assignment_count !== 1 ? 's' : ''} ·{' '}
                  {p.rule_count ?? 0} rule{p.rule_count !== 1 ? 's' : ''}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => clone.mutate(p.id)}
                  disabled={clone.isPending}
                  title="Clone policy"
                >
                  Clone
                </button>
                {!p.is_default && (
                  <button
                    className="btn-sm text-red-600 border border-red-200 hover:bg-red-50 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
                    onClick={() => setDeleting(p.id)}
                  >
                    Delete
                  </button>
                )}
                <Link to={`/admin/policies/${p.id}`} className="btn-primary btn-sm">
                  Edit →
                </Link>
              </div>
            </div>
          ))}

          {policies.length === 0 && (
            <div className="card p-10 text-center text-slate-400 text-sm">
              No policies configured. Click <strong>+ New Policy</strong> to get started.
            </div>
          )}
        </div>
      )}

      {/* Delete confirm modal */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h2 className="font-semibold text-slate-900 mb-2">Delete Policy?</h2>
            <p className="text-sm text-slate-500 mb-5">
              This policy will be deleted. Any students assigned to it will fall back to the default policy.
            </p>
            <div className="flex gap-3 justify-end">
              <button className="btn-secondary" onClick={() => setDeleting(null)}>Cancel</button>
              <button
                className="btn-sm bg-red-600 text-white hover:bg-red-700 rounded-lg px-4 py-2 text-sm font-medium"
                onClick={() => del.mutate(deleting)}
                disabled={del.isPending}
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
