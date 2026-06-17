import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------
const INPUT  = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const SELECT = INPUT + ' bg-white';
const BTN_P  = 'px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 transition-colors disabled:opacity-40';
const BTN_S  = 'px-3 py-1.5 rounded-lg text-sm font-medium border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40';
const BTN_D  = 'px-3 py-1.5 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 border border-red-200 transition-colors';

const RULE_TYPE_COLOR = {
  allow: 'bg-green-100 text-green-700 border border-green-200',
  deny:  'bg-red-100 text-red-700 border border-red-200',
};

const ACTION_COLOR = {
  block:   'bg-red-100 text-red-700 border border-red-200',
  allow:   'bg-green-100 text-green-700 border border-green-200',
  monitor: 'bg-blue-100 text-blue-700 border border-blue-200',
};

const RISK_COLOR = {
  high:   'bg-red-50 text-red-600',
  medium: 'bg-amber-50 text-amber-600',
  low:    'bg-slate-50 text-slate-500',
};

const TABS = ['Settings', 'Allow / Block', 'Categories', 'Blocklists', 'Assignments'];

function Field({ label, children, hint, col2 }) {
  return (
    <div className={col2 ? 'sm:col-span-2' : ''}>
      <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
function SettingsTab({ policy, policyId }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name:               policy.name               || '',
    description:        policy.description        || '',
    mode:               policy.mode               || 'standard',
    safe_search:        policy.safe_search        ?? true,
    youtube_restricted: policy.youtube_restricted || 'moderate',
    block_page_message: policy.block_page_message || '',
    is_default:         policy.is_default         || false,
  });
  const [saved, setSaved] = useState(false);
  const f = v => setForm(p => ({ ...p, ...v }));

  const save = useMutation({
    mutationFn: () => api.patch(`/policies/${policyId}`, form),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries(['policy', policyId]);
      qc.invalidateQueries(['policies']);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Policy Name">
          <input className={INPUT} value={form.name} onChange={e => f({ name: e.target.value })} />
        </Field>
        <Field label="Mode">
          <select className={SELECT} value={form.mode} onChange={e => f({ mode: e.target.value })}>
            <option value="standard">Standard — normal filtering</option>
            <option value="open">Open — allow all (no filtering)</option>
          </select>
        </Field>
        <Field label="Description" col2>
          <input className={INPUT} placeholder="Optional description"
            value={form.description} onChange={e => f({ description: e.target.value })} />
        </Field>
        <Field label="Block Page Message" hint="Shown to students when a site is blocked. Leave blank for default." col2>
          <textarea className={INPUT} rows={2} placeholder="This website has been blocked by your school's content filter."
            value={form.block_page_message} onChange={e => f({ block_page_message: e.target.value })} />
        </Field>
      </div>

      <div className="border border-slate-200 rounded-xl p-4 space-y-4">
        <h3 className="text-sm font-semibold text-slate-700">Safety Options</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-2 uppercase tracking-wide">Safe Search</label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.safe_search}
                onChange={e => f({ safe_search: e.target.checked })}
                className="w-4 h-4 rounded text-primary-600 accent-primary-600" />
              <span className="text-sm text-slate-700">Force safe search on Google, Bing, YouTube</span>
            </label>
            <p className="text-xs text-slate-400 mt-1 ml-6">Enforced by the browser extension on Chromebooks</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-2 uppercase tracking-wide">YouTube Restricted Mode</label>
            <select className={SELECT} value={form.youtube_restricted}
              onChange={e => f({ youtube_restricted: e.target.value })}>
              <option value="off">Off — no restrictions</option>
              <option value="moderate">Moderate — filter some content</option>
              <option value="strict">Strict — filter most content</option>
            </select>
            <p className="text-xs text-slate-400 mt-1">Enforced by the browser extension</p>
          </div>
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl p-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={form.is_default}
            onChange={e => f({ is_default: e.target.checked })}
            className="w-4 h-4 rounded text-primary-600 accent-primary-600" />
          <div>
            <p className="text-sm font-medium text-slate-800">Set as district default policy</p>
            <p className="text-xs text-slate-400">Applied to all students and devices with no other policy assigned</p>
          </div>
        </label>
      </div>

      {save.error && <p className="text-red-600 text-sm">{save.error.message}</p>}
      <div className="flex items-center gap-3">
        <button className={BTN_P} onClick={() => save.mutate()} disabled={!form.name || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span className="text-green-600 text-sm font-medium">✓ Saved</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Allow / Block tab
// ---------------------------------------------------------------------------
function DomainRulesTab({ policy, policyId }) {
  const qc = useQueryClient();
  const [newDomain,   setNewDomain]   = useState('');
  const [newType,     setNewType]     = useState('deny');
  const [search,      setSearch]      = useState('');
  const [filterType,  setFilterType]  = useState('');
  const [importError, setImportError] = useState('');
  const fileRef = useRef();

  const rules = policy.domainRules || [];

  const addRule = useMutation({
    mutationFn: () => api.post(`/policies/${policyId}/rules`, { domain: newDomain.trim(), rule_type: newType }),
    onSuccess:  () => { setNewDomain(''); qc.invalidateQueries(['policy', policyId]); },
  });

  const deleteRule = useMutation({
    mutationFn: ruleId => api.delete(`/policies/${policyId}/rules/${ruleId}`),
    onSuccess:  () => qc.invalidateQueries(['policy', policyId]),
  });

  const importRules = useMutation({
    mutationFn: rows => api.post(`/policies/${policyId}/rules/import`, rows),
    onSuccess: data => {
      qc.invalidateQueries(['policy', policyId]);
      setImportError(`Imported ${data.imported} rules${data.skipped ? `, ${data.skipped} skipped` : ''}`);
    },
    onError: e => setImportError(e.message),
  });

  const handleFile = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const lines = ev.target.result.split('\n').map(l => l.trim()).filter(Boolean);
      const rows  = [];
      for (const line of lines) {
        if (line.startsWith('domain')) continue; // header
        const [domain, rule_type] = line.split(',').map(s => s.trim());
        if (domain) rows.push({ domain, rule_type: rule_type || 'deny' });
      }
      importRules.mutate(rows);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleExport = async () => {
    const token = localStorage.getItem('cg_token');
    const resp  = await fetch(`/api/v1/policies/${policyId}/rules/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url;
    a.download = `policy_rules.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const filtered = rules.filter(r => {
    if (filterType && r.rule_type !== filterType) return false;
    if (search && !r.domain.includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Add rule */}
      <div className="flex gap-2 items-center">
        <select className={SELECT + ' w-24'} value={newType} onChange={e => setNewType(e.target.value)}>
          <option value="allow">Allow</option>
          <option value="deny">Block</option>
        </select>
        <input className={INPUT} placeholder="domain.com or *.domain.com"
          value={newDomain} onChange={e => setNewDomain(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && newDomain && addRule.mutate()} />
        <button className={BTN_P + ' whitespace-nowrap'} disabled={!newDomain.trim() || addRule.isPending}
          onClick={() => addRule.mutate()}>
          Add Rule
        </button>
      </div>
      {addRule.error && <p className="text-red-600 text-sm">{addRule.error.message}</p>}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-2">
          <input className={INPUT + ' w-48'} placeholder="Search domains…"
            value={search} onChange={e => setSearch(e.target.value)} />
          <select className={SELECT + ' w-28'} value={filterType} onChange={e => setFilterType(e.target.value)}>
            <option value="">All</option>
            <option value="allow">Allow</option>
            <option value="deny">Block</option>
          </select>
        </div>
        <div className="flex gap-2">
          <button className={BTN_S} onClick={() => fileRef.current?.click()}>
            Import CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFile} />
          <button className={BTN_S} onClick={handleExport} disabled={rules.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      {importError && (
        <p className={`text-sm ${importError.startsWith('Imported') ? 'text-green-600' : 'text-red-600'}`}>
          {importError}
        </p>
      )}

      <p className="text-xs text-slate-400">
        CSV format: <code className="bg-slate-100 px-1 rounded">domain,rule_type</code> — rule_type is <em>allow</em> or <em>deny</em>
      </p>

      {/* Rules table */}
      {filtered.length === 0 ? (
        <div className="text-center py-8 text-slate-400 text-sm">
          {rules.length === 0 ? 'No rules yet. Add a domain above or import a CSV.' : 'No rules match your filter.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Action</th>
                <th className="px-4 py-2 text-left">Domain</th>
                <th className="px-4 py-2 text-left">Added</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded font-semibold ${RULE_TYPE_COLOR[r.rule_type]}`}>
                      {r.rule_type === 'deny' ? 'Block' : 'Allow'}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-800">{r.domain}</td>
                  <td className="px-4 py-2 text-xs text-slate-400">
                    {r.added_at ? new Date(r.added_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => deleteRule.mutate(r.id)}
                      className="text-xs text-red-500 hover:underline">Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-2 text-xs text-slate-400 border-t border-slate-100">
            {filtered.length} of {rules.length} rules shown
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Categories tab
// ---------------------------------------------------------------------------
function CategoriesTab({ policy, policyId }) {
  const qc = useQueryClient();

  const { data: allCategories = [] } = useQuery({
    queryKey: ['categories-list'],
    queryFn:  () => api.get('/categories'),
  });

  const categoryRules = policy.categoryRules || [];
  const ruleMap = Object.fromEntries(categoryRules.map(r => [r.slug, r]));

  const setRule = useMutation({
    mutationFn: ({ category_slug, action }) =>
      api.put('/categories/policy-rules', { policy_id: policyId, category_slug, action }),
    onSuccess: () => qc.invalidateQueries(['policy', policyId]),
  });

  const removeRule = useMutation({
    mutationFn: ruleId => api.delete(`/categories/policy-rules/${ruleId}`),
    onSuccess:  () => qc.invalidateQueries(['policy', policyId]),
  });

  const handleAction = (slug, action, existingRuleId) => {
    if (action === 'inherit') {
      if (existingRuleId) removeRule.mutate(existingRuleId);
    } else {
      setRule.mutate({ category_slug: slug, action });
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Categories with no rule set inherit the district default.
        Categories marked <span className="font-medium text-red-600">Always Blocked</span> are enforced globally
        regardless of policy — you can lift them with an explicit <em>Allow</em> rule.
      </p>

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Category</th>
              <th className="px-4 py-2 text-left">Risk</th>
              <th className="px-4 py-2 text-left">Domains</th>
              <th className="px-4 py-2 text-left">This Policy</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {allCategories.map(cat => {
              const rule = ruleMap[cat.slug];
              const currentAction = rule?.action || 'inherit';
              return (
                <tr key={cat.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-800">{cat.name}</div>
                    {cat.is_blocked_default && (
                      <span className="text-xs text-red-500 font-medium">Always Blocked (global)</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${RISK_COLOR[cat.risk_level]}`}>
                      {cat.risk_level}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500 tabular-nums">
                    {(cat.domain_count || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <select
                      className="border border-slate-200 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
                      value={currentAction}
                      onChange={e => handleAction(cat.slug, e.target.value, rule?.id)}
                    >
                      <option value="inherit">Inherit default</option>
                      <option value="block">Block</option>
                      <option value="allow">Allow</option>
                      <option value="monitor">Monitor only</option>
                    </select>
                    {currentAction !== 'inherit' && (
                      <span className={`ml-2 text-xs px-1.5 py-0.5 rounded font-medium ${ACTION_COLOR[currentAction]}`}>
                        {currentAction}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocklists tab
// ---------------------------------------------------------------------------
function BlocklistsTab({ policy, policyId }) {
  const qc = useQueryClient();

  const { data: allBlocklists = [] } = useQuery({
    queryKey: ['blocklists-all'],
    queryFn:  () => api.get('/blocklists'),
    select:   d => d.sources || d || [],
  });

  const attached = new Set((policy.blocklists || []).map(b => b.source_id));

  const toggle = useMutation({
    mutationFn: ({ source_id, enabled }) =>
      enabled
        ? api.post(`/policies/${policyId}/blocklists`, { source_id })
        : api.delete(`/policies/${policyId}/blocklists/${source_id}`),
    onSuccess: () => qc.invalidateQueries(['policy', policyId]),
  });

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Enable curated blocklists to extend this policy's blocking coverage.
      </p>
      {allBlocklists.length === 0 ? (
        <div className="text-center py-8 text-slate-400 text-sm">
          No blocklists configured. Add them in the Blocklists section.
        </div>
      ) : (
        <div className="space-y-2">
          {allBlocklists.map(bl => {
            const enabled = attached.has(bl.id);
            return (
              <div key={bl.id} className="flex items-center justify-between p-4 border border-slate-200 rounded-xl hover:bg-slate-50">
                <div>
                  <div className="font-medium text-slate-800 text-sm">{bl.name}</div>
                  {bl.url && <div className="text-xs text-slate-400 font-mono truncate max-w-sm">{bl.url}</div>}
                  <div className="text-xs text-slate-500 mt-0.5">
                    {(bl.domain_count || 0).toLocaleString()} domains
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" checked={enabled}
                    onChange={e => toggle.mutate({ source_id: bl.id, enabled: e.target.checked })} />
                  <div className="w-11 h-6 bg-slate-200 rounded-full peer peer-checked:bg-primary-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
                </label>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assignments tab
// ---------------------------------------------------------------------------
function AssignmentsTab({ policy }) {
  const assignments = policy.assignments || [];

  const TYPE_LABEL = { student: 'Student', group: 'Group', ou: 'OU' };
  const TYPE_COLOR = {
    student: 'bg-blue-100 text-blue-700',
    group:   'bg-purple-100 text-purple-700',
    ou:      'bg-amber-100 text-amber-700',
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Assignments are managed from the Users, Groups, or Roster Sync pages.
        The policy closest to the student wins (student &gt; group &gt; OU &gt; district default).
      </p>
      {assignments.length === 0 ? (
        <div className="text-center py-8 text-slate-400 text-sm">
          No assignments yet — assign this policy from the Users or Groups page.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>
                {['Type','Target','Assigned'].map(h => (
                  <th key={h} className="px-4 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assignments.map(a => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${TYPE_COLOR[a.target_type] || 'bg-slate-100 text-slate-600'}`}>
                      {TYPE_LABEL[a.target_type] || a.target_type}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-medium text-slate-800">
                    {a.target_name || a.target_ou || a.target_id}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400">
                    {a.assigned_at ? new Date(a.assigned_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main PolicyEditor
// ---------------------------------------------------------------------------
export default function PolicyEditor() {
  const { policyId } = useParams();
  const navigate     = useNavigate();
  const qc           = useQueryClient();
  const [tab, setTab] = useState(0);

  const { data: policy, isLoading, error } = useQuery({
    queryKey: ['policy', policyId],
    queryFn:  () => api.get(`/policies/${policyId}`),
    retry:    false,
  });

  if (isLoading) return <div className="p-8 text-slate-400 text-sm">Loading policy…</div>;
  if (error)     return <div className="p-8 text-red-600 text-sm">Policy not found.</div>;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Link to="/admin/policies" className="hover:text-primary-600 font-medium">Policies</Link>
          <span>›</span>
          <span className="text-slate-900 font-semibold">{policy.name}</span>
          {policy.is_default && (
            <span className="ml-1 text-xs px-2 py-0.5 rounded-full bg-primary-100 text-primary-700 font-medium">
              Default
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded font-medium ${
            policy.mode === 'open' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
          }`}>
            {policy.mode}
          </span>
        </div>
        <Link to="/admin/policy-simulator"
          className="text-xs text-primary-600 hover:underline flex items-center gap-1">
          ⚡ Test this policy in Simulator →
        </Link>
      </div>

      {/* Tabs */}
      <div className="px-6 border-b border-slate-200 bg-white flex gap-1">
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === i
                ? 'border-primary-600 text-primary-700'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}>
            {t}
            {t === 'Allow / Block' && policy.domainRules?.length > 0 && (
              <span className="ml-1.5 text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">
                {policy.domainRules.length}
              </span>
            )}
            {t === 'Categories' && policy.categoryRules?.length > 0 && (
              <span className="ml-1.5 text-xs bg-primary-100 text-primary-600 px-1.5 py-0.5 rounded-full">
                {policy.categoryRules.length}
              </span>
            )}
            {t === 'Assignments' && policy.assignments?.length > 0 && (
              <span className="ml-1.5 text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">
                {policy.assignments.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto bg-slate-50">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {tab === 0 && <SettingsTab     policy={policy} policyId={policyId} />}
          {tab === 1 && <DomainRulesTab  policy={policy} policyId={policyId} />}
          {tab === 2 && <CategoriesTab   policy={policy} policyId={policyId} />}
          {tab === 3 && <BlocklistsTab   policy={policy} policyId={policyId} />}
          {tab === 4 && <AssignmentsTab  policy={policy} />}
        </div>
      </div>
    </div>
  );
}
