import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const MODES = ['standard', 'lesson', 'open'];

export default function PolicyEditor() {
  const { policyId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const isNew = policyId === 'new';

  const { data: policy, isLoading } = useQuery({
    queryKey: ['policy', policyId],
    queryFn:  () => api.get(`/policies/${policyId}`),
    enabled:  !isNew,
  });

  const [form, setForm]   = useState({ name: '', description: '', mode: 'standard', is_default: false });
  const [rules, setRules] = useState([]);
  const [newRule, setNewRule] = useState({ action: 'block', domain_pattern: '', comment: '' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (policy) {
      setForm({
        name:        policy.name        || '',
        description: policy.description || '',
        mode:        policy.mode        || 'standard',
        is_default:  policy.is_default  || false,
      });
      setRules(policy.rules || []);
    }
  }, [policy]);

  const save = useMutation({
    mutationFn: () => isNew
      ? api.post('/policies', form)
      : api.patch(`/policies/${policyId}`, form),
    onSuccess: data => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['policies'] });
      if (isNew && data?.id) navigate(`/admin/policies/${data.id}`, { replace: true });
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const addRule = useMutation({
    mutationFn: () => api.post(`/policies/${policyId}/rules`, newRule),
    onSuccess:  () => {
      setNewRule({ action: 'block', domain_pattern: '', comment: '' });
      qc.invalidateQueries({ queryKey: ['policy', policyId] });
    },
  });

  const deleteRule = useMutation({
    mutationFn: ruleId => api.delete(`/policies/${policyId}/rules/${ruleId}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['policy', policyId] }),
  });

  if (isLoading) return <div className="p-6 text-slate-400 text-sm">Loading…</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-5 text-sm text-slate-400">
        <Link to="/admin/policies" className="hover:text-primary-600">Policies</Link>
        <span>›</span>
        <span className="text-slate-700">{isNew ? 'New Policy' : (form.name || 'Edit Policy')}</span>
      </div>

      {/* Meta form */}
      <div className="card p-6 mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-4">Policy Settings</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Name</label>
            <input className="input" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <label className="label">Mode</label>
            <select className="input" value={form.mode}
              onChange={e => setForm(f => ({ ...f, mode: e.target.value }))}>
              {MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="label">Description</label>
            <input className="input" placeholder="Optional description" value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="sm:col-span-2 flex items-center gap-2">
            <input
              type="checkbox" id="is_default" className="w-4 h-4 rounded text-primary-600"
              checked={form.is_default}
              onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))}
            />
            <label htmlFor="is_default" className="text-sm text-slate-600 cursor-pointer">
              Set as district default policy
            </label>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-5 pt-5 border-t border-slate-100">
          <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save Changes'}
          </button>
          {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
        </div>
      </div>

      {/* Rules */}
      {!isNew && (
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">Rules</h2>

          {/* Add rule form */}
          <div className="flex gap-2 mb-5">
            <select
              className="input w-28"
              value={newRule.action}
              onChange={e => setNewRule(r => ({ ...r, action: e.target.value }))}
            >
              <option value="block">block</option>
              <option value="allow">allow</option>
            </select>
            <input
              className="input flex-1"
              placeholder="Domain pattern, e.g. *.tiktok.com"
              value={newRule.domain_pattern}
              onChange={e => setNewRule(r => ({ ...r, domain_pattern: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && newRule.domain_pattern && addRule.mutate()}
            />
            <input
              className="input w-44"
              placeholder="Comment (optional)"
              value={newRule.comment}
              onChange={e => setNewRule(r => ({ ...r, comment: e.target.value }))}
            />
            <button
              className="btn-primary flex-shrink-0"
              disabled={!newRule.domain_pattern || addRule.isPending}
              onClick={() => addRule.mutate()}
            >
              Add
            </button>
          </div>

          {/* Rule list */}
          {rules.length === 0 ? (
            <div className="text-slate-400 text-sm py-4 text-center">
              No rules. Add a rule above, or attach blocklists via Policies page.
            </div>
          ) : (
            <div className="space-y-1.5">
              {rules.map(r => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-slate-50 border border-transparent hover:border-slate-200"
                >
                  <span className={`w-12 text-center rounded px-2 py-0.5 text-xs font-semibold flex-shrink-0
                    ${r.action === 'allow' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {r.action}
                  </span>
                  <span className="font-mono text-sm text-slate-700 flex-1">{r.domain_pattern}</span>
                  {r.comment && <span className="text-xs text-slate-400 italic hidden sm:block">{r.comment}</span>}
                  <span className="text-xs text-slate-400 flex-shrink-0">
                    P{r.priority ?? '—'}
                  </span>
                  <button
                    onClick={() => deleteRule.mutate(r.id)}
                    className="text-slate-300 hover:text-red-500 transition-colors text-sm flex-shrink-0"
                    title="Remove rule"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
