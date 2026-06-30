import { useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
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

const TABS = ['Settings', 'Allow / Block', 'Categories', 'Blocklists', 'YouTube', 'Assignments'];

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
    default_action:     policy.default_action     || 'allow',
    safe_search:        policy.safe_search        ?? true,
    youtube_restricted: policy.youtube_restricted || 'moderate',
    block_page_message: policy.block_page_message || '',
    block_direct_ip:    policy.block_direct_ip    || false,
    is_default:         policy.is_default         || false,
    is_network_policy:  policy.is_network_policy  || false,
  });
  const [saved, setSaved] = useState(false);
  const f = v => setForm(p => ({ ...p, ...v }));

  const save = useMutation({
    mutationFn: () => api.patch(`/policies/${policyId}`, form),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['policy', policyId] });
      qc.invalidateQueries({ queryKey: ['policies'] });
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
            <option value="standard">Standard — filtered access</option>
            <option value="open">Open — allow all (no filtering)</option>
          </select>
        </Field>
        {form.mode === 'standard' && (
          <Field label="Filtering Stance" col2
            hint={form.default_action === 'block'
              ? 'Block everything — only sites in the Allowed Domains list will resolve.'
              : 'Allow everything except what blocklists, categories, and deny rules block.'}>
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => f({ default_action: 'allow' })}
                className={`flex-1 px-3 py-2 text-center transition-colors ${
                  form.default_action !== 'block'
                    ? 'bg-primary-600 text-white font-medium'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                Allow by default
              </button>
              <button
                type="button"
                onClick={() => f({ default_action: 'block' })}
                className={`flex-1 px-3 py-2 text-center transition-colors border-l border-slate-200 ${
                  form.default_action === 'block'
                    ? 'bg-orange-500 text-white font-medium'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                Block by default
              </button>
            </div>
            {form.default_action === 'block' && (
              <div className="mt-2 text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                Allowlist-only mode: students can only reach sites you add to the
                <strong> Allowed Domains</strong> list on the Domain Rules tab.
                Blocklists and category rules are bypassed (already blocked anyway).
              </div>
            )}
          </Field>
        )}
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
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-2 uppercase tracking-wide">Direct-IP Browsing</label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.block_direct_ip}
                onChange={e => f({ block_direct_ip: e.target.checked })}
                className="w-4 h-4 rounded text-primary-600 accent-primary-600" />
              <span className="text-sm text-slate-700">Block navigation straight to an IP address</span>
            </label>
            <p className="text-xs text-slate-400 mt-1 ml-6">
              DNS filtering can't see a navigation that never resolves a hostname — this closes that gap
              via the extension. School/local network IPs are always allowed.
            </p>
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

      <div className="border border-amber-200 bg-amber-50 rounded-xl p-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={form.is_network_policy}
            onChange={e => f({ is_network_policy: e.target.checked })}
            className="w-4 h-4 rounded text-amber-600 accent-amber-600" />
          <div>
            <p className="text-sm font-medium text-slate-800">Use as DNS Network Policy</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Enforced at the DNS level for <strong>every</strong> device on the network — students, staff, guests,
              unmanaged devices — regardless of who's signed in. This is the one network-wide floor; only one policy
              can hold this role at a time. A student or staff member's own OU/group/student-level policy (assigned
              in the Assignments tab of whichever policy applies to them) layers <em>additional</em> restrictions on
              top of this floor via the extension — it can never loosen what the floor blocks here.
            </p>
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
  const [ggOpen,       setGgOpen]      = useState(false);
  const fileRef = useRef();

  const rules = policy.domainRules || [];

  const addRule = useMutation({
    mutationFn: () => api.post(`/policies/${policyId}/rules`, { domain: newDomain.trim(), rule_type: newType }),
    onSuccess:  () => { setNewDomain(''); qc.invalidateQueries({ queryKey: ['policy', policyId] }); },
  });

  const deleteRule = useMutation({
    mutationFn: ruleId => api.delete(`/policies/${policyId}/rules/${ruleId}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['policy', policyId] }),
  });

  const importRules = useMutation({
    mutationFn: rows => api.post(`/policies/${policyId}/rules/import`, rows),
    onSuccess: data => {
      qc.invalidateQueries({ queryKey: ['policy', policyId] });
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
      <p className="text-xs text-slate-400">
        Subdomains are matched automatically — github.com also covers api.github.com, so extra wildcards aren't needed.
      </p>
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
          <button className={BTN_S} onClick={() => setGgOpen(true)}>
            Import from GoGuardian
          </button>
        </div>
      </div>

      {ggOpen && <GoGuardianImportModal policyId={policyId} onClose={() => setGgOpen(false)} />}

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

      <UrlRulesSection policy={policy} policyId={policyId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// URL-path rules — extension-only, since DNS never sees a path. Shown below
// the domain rules in the same tab since they're both "rule lists for this
// policy", just enforced at different layers.
// ---------------------------------------------------------------------------
function UrlRulesSection({ policy, policyId }) {
  const qc = useQueryClient();
  const [pattern,  setPattern]  = useState('');
  const [type,      setType]    = useState('deny');
  const rules = policy.urlRules || [];

  const addRule = useMutation({
    mutationFn: () => api.post(`/policies/${policyId}/url-rules`, { pattern: pattern.trim(), rule_type: type }),
    onSuccess:  () => { setPattern(''); qc.invalidateQueries({ queryKey: ['policy', policyId] }); },
  });

  const deleteRule = useMutation({
    mutationFn: ruleId => api.delete(`/policies/${policyId}/url-rules/${ruleId}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['policy', policyId] }),
  });

  return (
    <div className="mt-8 pt-6 border-t border-slate-200 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-700">URL-Path Rules <span className="text-xs font-normal text-slate-400">(Extension only)</span></h3>
        <p className="text-xs text-slate-400 mt-1">
          DNS filtering can only see a domain, never a path — so a rule like <code className="bg-slate-100 px-1 rounded">youtube.com/watch*v=X</code> or
          <code className="bg-slate-100 px-1 rounded ml-1">*.example.com/games/*</code> can only be enforced by the Chrome extension on managed devices,
          not at the network/DNS level. Use <code className="bg-slate-100 px-1 rounded">*</code> as a wildcard.
        </p>
      </div>

      <div className="flex gap-2 items-center">
        <select className={SELECT + ' w-24'} value={type} onChange={e => setType(e.target.value)}>
          <option value="allow">Allow</option>
          <option value="deny">Block</option>
        </select>
        <input className={INPUT} placeholder="youtube.com/watch*v=BUjeVodnbzA"
          value={pattern} onChange={e => setPattern(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && pattern && addRule.mutate()} />
        <button className={BTN_P + ' whitespace-nowrap'} disabled={!pattern.trim() || addRule.isPending}
          onClick={() => addRule.mutate()}>
          Add Rule
        </button>
      </div>
      {addRule.error && <p className="text-red-600 text-sm">{addRule.error.message}</p>}

      {rules.length === 0 ? (
        <div className="text-center py-6 text-slate-400 text-sm">
          No URL-path rules yet — add one above or import from GoGuardian.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Action</th>
                <th className="px-4 py-2 text-left">Pattern</th>
                <th className="px-4 py-2 text-left">Source</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rules.map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded font-semibold ${RULE_TYPE_COLOR[r.rule_type]}`}>
                      {r.rule_type === 'deny' ? 'Block' : 'Allow'}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-800 break-all">{r.pattern}</td>
                  <td className="px-4 py-2 text-xs text-slate-400">
                    {r.source === 'goguardian_import' ? 'GoGuardian import' : 'Manual'}
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
            {rules.length} rule{rules.length === 1 ? '' : 's'}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GoGuardian CSV import — upload, preview classification (domain vs URL-path
// rules, anything skipped), then confirm before writing.
// ---------------------------------------------------------------------------
function GoGuardianImportModal({ policyId, onClose }) {
  const qc = useQueryClient();
  const [file,    setFile]    = useState(null);
  const [preview, setPreview] = useState(null);
  const [error,   setError]   = useState('');
  const [busy,    setBusy]    = useState(false);
  const [done,    setDone]    = useState(null);

  const runRequest = async (previewMode) => {
    const form = new FormData();
    form.append('file', file);
    const token = localStorage.getItem('cg_token');
    const res = await fetch(
      `${import.meta.env.VITE_API_URL || ''}/api/v1/policies/${policyId}/import-goguardian${previewMode ? '?preview=1' : ''}`,
      { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  const handlePreview = async () => {
    if (!file) { setError('Choose a CSV file first'); return; }
    setError(''); setBusy(true);
    try {
      setPreview(await runRequest(true));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    setError(''); setBusy(true);
    try {
      const result = await runRequest(false);
      setDone(result);
      qc.invalidateQueries({ queryKey: ['policy', policyId] });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-slate-800">Import from GoGuardian</h3>

        {!done ? (
          <>
            <p className="text-sm text-slate-500">
              Upload a GoGuardian filter-policy CSV export (<code className="bg-slate-100 px-1 rounded">action,url,...</code>).
              Domain-only rows become DNS + extension rules; anything with a URL path or an un-collapsible
              wildcard becomes an extension-only URL-path rule, since DNS can't see a path.
            </p>
            <input type="file" accept=".csv,.txt"
              onChange={e => { setFile(e.target.files[0] || null); setPreview(null); setError(''); }}
              className="block w-full text-sm" />

            {error && <p className="text-red-600 text-sm">{error}</p>}

            {preview && (
              <div className="border border-slate-200 rounded-lg p-3 text-sm space-y-1 bg-slate-50">
                <p><strong>{preview.totalRows}</strong> rows read</p>
                <p><strong>{preview.domainRules.length}</strong> domain rules (DNS + extension)</p>
                <p><strong>{preview.urlRules.length}</strong> URL-path rules (extension only)</p>
                {preview.skipped.length > 0 && (
                  <p className="text-amber-600"><strong>{preview.skipped.length}</strong> rows skipped (e.g. bare IP addresses)</p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button className={BTN_S} onClick={onClose}>Cancel</button>
              {!preview ? (
                <button className={BTN_P} disabled={!file || busy} onClick={handlePreview}>
                  {busy ? 'Reading…' : 'Preview'}
                </button>
              ) : (
                <button className={BTN_P} disabled={busy} onClick={handleConfirm}>
                  {busy ? 'Importing…' : `Import ${preview.domainRules.length + preview.urlRules.length} rules`}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-green-600">
              Imported {done.domainImported} domain rules and {done.urlImported} URL-path rules
              {done.skipped ? ` (${done.skipped} skipped)` : ''}.
            </p>
            <div className="flex justify-end">
              <button className={BTN_P} onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policy', policyId] }),
  });

  const removeRule = useMutation({
    mutationFn: ruleId => api.delete(`/categories/policy-rules/${ruleId}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['policy', policyId] }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policy', policyId] }),
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
// ---------------------------------------------------------------------------
// YouTube tab
// ---------------------------------------------------------------------------
const YT_CATEGORIES = [
  { id: 'film_animation',      label: 'Film & Animation',      emoji: '🎬', edu: false },
  { id: 'music',               label: 'Music',                  emoji: '🎵', edu: false },
  { id: 'sports',              label: 'Sports',                 emoji: '⚽', edu: false },
  { id: 'gaming',              label: 'Gaming',                 emoji: '🎮', edu: false },
  { id: 'entertainment',       label: 'Entertainment',          emoji: '🎭', edu: false },
  { id: 'comedy',              label: 'Comedy',                 emoji: '😂', edu: false },
  { id: 'people_blogs',        label: 'People & Blogs',         emoji: '👤', edu: false },
  { id: 'autos_vehicles',      label: 'Autos & Vehicles',       emoji: '🚗', edu: false },
  { id: 'pets_animals',        label: 'Pets & Animals',         emoji: '🐾', edu: false },
  { id: 'travel_events',       label: 'Travel & Events',        emoji: '✈️', edu: false },
  { id: 'howto_style',         label: 'How-to & Style',         emoji: '✂️', edu: false },
  { id: 'news_politics',       label: 'News & Politics',        emoji: '📰', edu: false },
  { id: 'education',           label: 'Education',              emoji: '📚', edu: true  },
  { id: 'science_technology',  label: 'Science & Technology',   emoji: '🔬', edu: true  },
  { id: 'nonprofits_activism', label: 'Nonprofits & Activism',  emoji: '🤝', edu: true  },
];

function YouTubeTab({ policy, policyId }) {
  const qc = useQueryClient();
  const raw   = policy.youtube_categories || {};
  const ytMode = raw.mode || 'restricted';          // 'restricted' | 'allowlist' | 'blocklist' | 'off'
  const blocked = raw.blocked || [];
  const allowed = raw.allowed || [];

  const [mode,    setMode]    = useState(ytMode);
  const [blocked_, setBlocked] = useState(new Set(blocked));
  const [allowed_, setAllowed] = useState(new Set(allowed));
  const [saved,   setSaved]   = useState(false);

  const save = useMutation({
    mutationFn: () => api.patch(`/policies/${policyId}`, {
      youtube_categories: {
        mode,
        blocked: [...blocked_],
        allowed: [...allowed_],
      },
    }),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['policy', policyId] });
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const toggleSet = (setter, id) => setter(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const isBlocklist  = mode === 'blocklist';
  const isAllowlist  = mode === 'allowlist';

  return (
    <div className="space-y-6">
      {/* Mode */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">YouTube Filtering Mode</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { id: 'off',       label: 'Off',             desc: 'No YouTube category restrictions' },
            { id: 'restricted', label: 'Restricted Mode', desc: 'Enforce YouTube Restricted Mode (hides mature content)' },
            { id: 'blocklist', label: 'Block Categories', desc: 'Block specific categories, allow everything else' },
            { id: 'allowlist', label: 'Allow Only',       desc: 'Only allow selected categories, block all others' },
          ].map(opt => (
            <button key={opt.id} onClick={() => setMode(opt.id)}
              className={`text-left p-3 rounded-lg border-2 transition-all ${
                mode === opt.id
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}>
              <div className="font-medium text-sm text-slate-800">{opt.label}</div>
              <div className="text-xs text-slate-500 mt-0.5">{opt.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Category grid — show when blocklist or allowlist mode */}
      {(isBlocklist || isAllowlist) && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-700">
              {isBlocklist ? 'Blocked Categories' : 'Allowed Categories'}
            </h3>
            <span className="text-xs text-slate-400">
              {isBlocklist
                ? `${blocked_.size} blocked`
                : `${allowed_.size} allowed`}
            </span>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            {isBlocklist
              ? 'Toggle ON to block a category. Everything else is allowed.'
              : 'Toggle ON to allow a category. Everything else is blocked.'}
          </p>

          {/* Educational note */}
          {isAllowlist && (
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
              📚 <strong>Tip:</strong> Education and Science &amp; Technology are marked as educational — consider keeping them allowed.
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {YT_CATEGORIES.map(cat => {
              const active = isBlocklist ? blocked_.has(cat.id) : allowed_.has(cat.id);
              const setter = isBlocklist
                ? () => toggleSet(setBlocked, cat.id)
                : () => toggleSet(setAllowed, cat.id);
              return (
                <button key={cat.id} onClick={setter}
                  className={`flex items-center gap-2 p-3 rounded-lg border-2 text-left transition-all ${
                    active
                      ? isBlocklist
                        ? 'border-red-400 bg-red-50'
                        : 'border-green-400 bg-green-50'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}>
                  <span className="text-lg flex-shrink-0">{cat.emoji}</span>
                  <div className="min-w-0">
                    <div className={`text-xs font-medium leading-tight ${
                      active ? (isBlocklist ? 'text-red-700' : 'text-green-700') : 'text-slate-700'
                    }`}>
                      {cat.label}
                    </div>
                    {cat.edu && (
                      <div className="text-xs text-blue-500">Educational</div>
                    )}
                  </div>
                  <div className="ml-auto flex-shrink-0">
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      active
                        ? isBlocklist ? 'border-red-500 bg-red-500' : 'border-green-500 bg-green-500'
                        : 'border-slate-300'
                    }`}>
                      {active && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 10 8"><path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Preview summary */}
      {mode !== 'off' && (
        <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 text-xs text-slate-600">
          <strong>Enforcement note:</strong> YouTube category filtering is enforced by the ClassGuard
          browser extension on managed Chromebooks. Devices without the extension will only receive
          DNS-level safe search enforcement via YouTube Restricted Mode (if enabled above).
        </div>
      )}

      {save.error && <p className="text-red-600 text-sm">{save.error.message}</p>}
      <div className="flex items-center gap-3">
        <button className={BTN_P} onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save YouTube Settings'}
        </button>
        {saved && <span className="text-green-600 text-sm font-medium">✓ Saved</span>}
      </div>

      {/* Individual video rules */}
      <VideoRulesPanel policy={policy} policyId={policyId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual YouTube video allow/block rules
// ---------------------------------------------------------------------------
function VideoRulesPanel({ policy, policyId }) {
  const qc = useQueryClient();
  const [input,      setInput]      = useState('');
  const [addAction,  setAddAction]  = useState('block');
  const [lookupData, setLookupData] = useState(null);
  const [looking,    setLooking]    = useState(false);
  const [lookupErr,  setLookupErr]  = useState('');

  const rules = policy.youtubeVideoRules || [];

  function extractVideoId(raw) {
    const s = raw.trim();
    // Full URL: youtube.com/watch?v=ID  or  youtu.be/ID
    try {
      const url = new URL(s.startsWith('http') ? s : `https://${s}`);
      if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') return url.searchParams.get('v') || null;
      if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('?')[0] || null;
    } catch {}
    // Bare video ID (11 chars, alphanumeric + _ -)
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    return null;
  }

  const handleLookup = async () => {
    const vid = extractVideoId(input);
    if (!vid) { setLookupErr('Paste a YouTube URL or 11-character video ID'); return; }
    setLookupErr(''); setLooking(true); setLookupData(null);
    try {
      const data = await api.get(`/youtube/video-info?id=${vid}`);
      const video = Array.isArray(data) ? data[0] : data;
      if (!video || video.error) { setLookupErr(video?.error || 'Video not found'); return; }
      setLookupData(video);
    } catch (e) {
      setLookupErr(e.message || 'Lookup failed — check YouTube API key in Settings');
    } finally {
      setLooking(false);
    }
  };

  const addRule = useMutation({
    mutationFn: video => api.post(`/policies/${policyId}/youtube-videos`, {
      video_id:      video.id,
      action:        addAction,
      title:         video.title,
      channel_title: video.channelTitle,
      thumbnail_url: video.thumbnailUrl,
      category_id:   video.categoryId,
      category_name: video.categoryName,
    }),
    onSuccess: () => {
      setInput(''); setLookupData(null); setLookupErr('');
      qc.invalidateQueries({ queryKey: ['policy', policyId] });
    },
    onError: e => setLookupErr(e.message),
  });

  const removeRule = useMutation({
    mutationFn: videoId => api.delete(`/policies/${policyId}/youtube-videos/${videoId}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['policy', policyId] }),
  });

  return (
    <div className="space-y-4 pt-2">
      <div className="border-t border-slate-200 pt-6">
        <h3 className="text-sm font-semibold text-slate-700 mb-1">Individual Video Rules</h3>
        <p className="text-xs text-slate-500 mb-4">
          Explicitly allow or block specific videos by URL or ID. These rules take priority over category settings.
          Video title and category are fetched from YouTube's API and cached for 24 hours.
        </p>

        {/* Search / lookup */}
        <div className="flex gap-2 mb-3">
          <select className={SELECT + ' w-24'} value={addAction} onChange={e => setAddAction(e.target.value)}>
            <option value="block">Block</option>
            <option value="allow">Allow</option>
          </select>
          <input className={INPUT} placeholder="Paste YouTube URL or video ID"
            value={input} onChange={e => { setInput(e.target.value); setLookupData(null); setLookupErr(''); }}
            onKeyDown={e => e.key === 'Enter' && handleLookup()} />
          <button className={BTN_S + ' whitespace-nowrap'} onClick={handleLookup}
            disabled={looking || !input.trim()}>
            {looking ? 'Looking up…' : 'Look Up'}
          </button>
        </div>

        {lookupErr && <p className="text-red-600 text-sm mb-3">{lookupErr}</p>}

        {/* Video preview card */}
        {lookupData && (
          <div className="flex items-center gap-3 p-3 border border-slate-200 rounded-xl bg-slate-50 mb-3">
            {lookupData.thumbnailUrl && (
              <img src={lookupData.thumbnailUrl} alt="" className="w-20 h-14 object-cover rounded flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-slate-800 truncate">{lookupData.title}</div>
              <div className="text-xs text-slate-500 mt-0.5">{lookupData.channelTitle}</div>
              {lookupData.categoryName && (
                <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded mt-1 inline-block">
                  {lookupData.categoryName}
                </span>
              )}
            </div>
            <button className={addAction === 'block' ? BTN_D : BTN_P}
              onClick={() => addRule.mutate(lookupData)}
              disabled={addRule.isPending}>
              {addAction === 'block' ? '🚫 Block' : '✅ Allow'} this video
            </button>
          </div>
        )}

        {/* Current rules */}
        {rules.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
                <tr>
                  <th className="px-3 py-2 text-left w-8"></th>
                  <th className="px-3 py-2 text-left">Video</th>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-left">Rule</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.map(r => (
                  <tr key={r.video_id} className="hover:bg-slate-50">
                    <td className="px-3 py-2">
                      {r.thumbnail_url
                        ? <img src={r.thumbnail_url} alt="" className="w-12 h-9 object-cover rounded" />
                        : <div className="w-12 h-9 bg-slate-200 rounded flex items-center justify-center text-slate-400 text-xs">YT</div>
                      }
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800 text-xs truncate max-w-xs">
                        {r.title || r.video_id}
                      </div>
                      <div className="text-xs text-slate-400">{r.channel_title}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.category_name || '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-semibold ${
                        r.action === 'block' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                      }`}>
                        {r.action}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => removeRule.mutate(r.video_id)}
                        className="text-xs text-red-500 hover:underline">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-6 text-slate-400 text-sm border border-dashed border-slate-200 rounded-xl">
            No individual video rules yet. Look up a video above to add one.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assignments tab — full interactive CRUD
// ---------------------------------------------------------------------------
const ASSIGN_TYPE_LABEL = {
  student: 'Student',
  group:   'Group',
  ou:      'OU / Org Unit',
  subnet:  'DNS Subnet',
};
const ASSIGN_TYPE_COLOR = {
  student: 'bg-blue-100 text-blue-700 border border-blue-200',
  group:   'bg-purple-100 text-purple-700 border border-purple-200',
  ou:      'bg-amber-100 text-amber-700 border border-amber-200',
  subnet:  'bg-teal-100 text-teal-700 border border-teal-200',
};

function AssignmentsTab({ policy, policyId }) {
  const qc          = useQueryClient();
  const assignments = policy.assignments || [];

  const [addType,    setAddType]    = useState('ou');
  const [ouPath,     setOuPath]     = useState('');
  const [subnet,     setSubnet]     = useState('');
  const [studentId,  setStudentId]  = useState('');
  const [groupId,    setGroupId]    = useState('');
  const [location,   setLocation]   = useState('any');
  const [addError,   setAddError]   = useState('');

  const { data: ouList = [] } = useQuery({
    queryKey: ['ou-list'],
    queryFn:  () => api.get('/policies/ou-list'),
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users-list'],
    queryFn:  () => api.get('/users?limit=500'),
    select:   d => (d.users || d || []).filter(u => u.role === 'student'),
  });

  const { data: groups = [] } = useQuery({
    queryKey: ['groups-list'],
    queryFn:  () => api.get('/groups'),
    select:   d => d.groups || d || [],
  });

  const addAssignment = useMutation({
    mutationFn: body => api.post(`/policies/${policyId}/assignments`, body),
    onSuccess: () => {
      setOuPath(''); setSubnet(''); setStudentId(''); setGroupId(''); setAddError('');
      qc.invalidateQueries({ queryKey: ['policy', policyId] });
    },
    onError: e => setAddError(e.message || 'Failed to add assignment'),
  });

  const removeAssignment = useMutation({
    mutationFn: id => api.delete(`/policies/${policyId}/assignments/${id}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['policy', policyId] }),
  });

  const handleAdd = () => {
    setAddError('');
    if (addType === 'ou') {
      if (!ouPath.trim()) { setAddError('Enter an OU path'); return; }
      addAssignment.mutate({ target_type: 'ou', target_ou: ouPath.trim(), location });
    } else if (addType === 'subnet') {
      if (!subnet.trim()) { setAddError('Enter a CIDR (e.g. 192.168.100.0/24)'); return; }
      if (!/^[\d.]+\/\d+$/.test(subnet.trim())) { setAddError('Invalid CIDR format — use x.x.x.x/nn'); return; }
      addAssignment.mutate({ target_type: 'subnet', target_subnet: subnet.trim() });
    } else if (addType === 'student') {
      if (!studentId) { setAddError('Select a student'); return; }
      addAssignment.mutate({ target_type: 'student', target_id: studentId, location });
    } else if (addType === 'group') {
      if (!groupId) { setAddError('Select a group'); return; }
      addAssignment.mutate({ target_type: 'group', target_id: groupId, location });
    }
  };

  const LOCATION_LABEL = { any: 'Any (same everywhere)', on_campus: 'On-Campus only', off_campus: 'Off-Campus only' };

  const LocationPicker = () => (
    <div className="space-y-1">
      <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide">When does this apply?</label>
      <div className="flex gap-2 flex-wrap">
        {Object.entries(LOCATION_LABEL).map(([loc, label]) => (
          <button key={loc} onClick={() => setLocation(loc)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              location === loc ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'
            }`}>
            {label}
          </button>
        ))}
      </div>
      {location !== 'any' && (
        <p className="text-xs text-slate-400">
          Determined by source IP at DNS-query time — On-Campus means a documented school subnet in IPAM; everything else counts as Off-Campus.
          You can set both an On-Campus and an Off-Campus assignment for the same target to have different policies in each.
        </p>
      )}
    </div>
  );

  // Build OU tree for display (prefix-sorted = hierarchical order)
  const ouTree = [...ouList].sort();

  return (
    <div className="space-y-6">
      {/* Inheritance note */}
      <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700 space-y-1">
        <p className="font-medium">Policy precedence (most specific wins):</p>
        <p className="text-xs">Student assignment &gt; Group membership &gt; OU (most-specific path first) &gt; District default</p>
        <p className="text-xs mt-1">
          <strong>DNS Subnet</strong> — applied to any device on that subnet that hasn't registered the ClassGuard extension
          (iPads, BYOD, guest networks). Subnet policy is bypassed once a device is identified as a student.
        </p>
      </div>

      {/* Add new assignment panel */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-700">Add Assignment</h3>

        {/* Type selector */}
        <div className="flex gap-2 flex-wrap">
          {Object.entries(ASSIGN_TYPE_LABEL).map(([type, label]) => (
            <button key={type} onClick={() => { setAddType(type); setAddError(''); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                addType === type
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* OU input */}
        {addType === 'ou' && (
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide">
              OU Path
            </label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input className={INPUT} placeholder="/Students/9th Grade"
                  list="ou-datalist"
                  value={ouPath} onChange={e => setOuPath(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()} />
                <datalist id="ou-datalist">
                  {ouTree.map(p => <option key={p} value={p} />)}
                </datalist>
              </div>
              <button className={BTN_P + ' whitespace-nowrap'} onClick={handleAdd}
                disabled={addAssignment.isPending}>
                + Assign
              </button>
            </div>
            <LocationPicker/>
            {ouTree.length > 0 ? (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-3 py-1.5 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Known OUs {ouTree.length > 0 && `(${ouTree.length})`}
                </div>
                <div className="max-h-48 overflow-y-auto divide-y divide-slate-100">
                  {ouTree.map(p => {
                    const depth   = (p.match(/\//g) || []).length - 1;
                    const already = assignments.some(a => a.target_ou === p && a.target_type === 'ou' && (a.location || 'any') === location);
                    return (
                      <button key={p} disabled={already}
                        onClick={() => { setOuPath(p); }}
                        className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-1 ${
                          already ? 'text-slate-300 cursor-default' : 'hover:bg-primary-50 text-slate-700'
                        }`}>
                        <span className="text-slate-300 select-none" style={{ marginLeft: depth * 12 }}>
                          {depth > 0 ? '└ ' : ''}
                        </span>
                        <span className="font-mono">{p.split('/').pop()}</span>
                        <span className="text-slate-400 ml-1 font-normal">{p}</span>
                        {already && <span className="ml-auto text-xs text-slate-300">already assigned for this location</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-400">
                No OUs synced yet — enter a path manually, e.g. <code className="bg-slate-100 px-1 rounded">/Students</code> or <code className="bg-slate-100 px-1 rounded">/Students/Grade 9</code>
              </p>
            )}
          </div>
        )}

        {/* Subnet input */}
        {addType === 'subnet' && (
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Subnet CIDR
            </label>
            <div className="flex gap-2">
              <input className={INPUT} placeholder="192.168.100.0/24"
                value={subnet} onChange={e => setSubnet(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()} />
              <button className={BTN_P + ' whitespace-nowrap'} onClick={handleAdd}
                disabled={addAssignment.isPending}>
                + Assign
              </button>
            </div>
            <p className="text-xs text-slate-400">
              This policy will apply to any DNS query from an IP in this subnet that has no registered student device.
              Useful for iPad carts, BYOD VLANs, and guest WiFi.
            </p>
            <div className="grid grid-cols-2 gap-2 mt-2">
              {[
                ['192.168.100.0/24', 'Student VLAN'],
                ['10.0.50.0/24',     'iPad Cart'],
                ['172.16.200.0/24',  'BYOD WiFi'],
                ['192.168.200.0/24', 'Guest Network'],
              ].map(([cidr, label]) => (
                <button key={cidr} onClick={() => setSubnet(cidr)}
                  className="text-left px-3 py-2 rounded-lg border border-slate-200 hover:border-primary-400 hover:bg-primary-50 text-xs transition-colors">
                  <div className="font-mono text-slate-700">{cidr}</div>
                  <div className="text-slate-400">{label}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Student picker */}
        {addType === 'student' && (
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Student
            </label>
            <div className="flex gap-2">
              <select className={SELECT} value={studentId} onChange={e => setStudentId(e.target.value)}>
                <option value="">— Select student —</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.full_name || u.email}
                    {u.google_ou ? ` (${u.google_ou.split('/').filter(Boolean).pop()})` : ''}
                  </option>
                ))}
              </select>
              <button className={BTN_P + ' whitespace-nowrap'} onClick={handleAdd}
                disabled={addAssignment.isPending}>
                + Assign
              </button>
            </div>
            <LocationPicker/>
          </div>
        )}

        {/* Group picker */}
        {addType === 'group' && (
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Group
            </label>
            <div className="flex gap-2">
              <select className={SELECT} value={groupId} onChange={e => setGroupId(e.target.value)}>
                <option value="">— Select group —</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <button className={BTN_P + ' whitespace-nowrap'} onClick={handleAdd}
                disabled={addAssignment.isPending}>
                + Assign
              </button>
            </div>
            <LocationPicker/>
          </div>
        )}

        {addError && <p className="text-red-600 text-sm">{addError}</p>}
      </div>

      {/* Current assignments */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Current Assignments</h3>
          <span className="text-xs text-slate-400">{assignments.length} total</span>
        </div>
        {assignments.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            No assignments yet. Use the panel above to assign this policy.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs font-semibold text-slate-500 uppercase bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-left">Target</th>
                <th className="px-4 py-2 text-left">Location</th>
                <th className="px-4 py-2 text-left">Assigned</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assignments.map(a => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded font-semibold ${ASSIGN_TYPE_COLOR[a.target_type] || 'bg-slate-100 text-slate-600'}`}>
                      {ASSIGN_TYPE_LABEL[a.target_type] || a.target_type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {a.target_type === 'ou' ? (
                      <div>
                        <div className="font-mono text-xs text-slate-700">{a.target_ou}</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          Applies to this OU and all sub-OUs below it
                        </div>
                      </div>
                    ) : a.target_type === 'subnet' ? (
                      <div>
                        <div className="font-mono text-xs text-slate-700">{a.target_subnet_str || a.target_name}</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          DNS filtering for unregistered devices on this subnet
                        </div>
                      </div>
                    ) : (
                      <span className="font-medium text-slate-800">
                        {a.target_name || a.target_ou || a.target_id}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {a.location === 'on_campus' ? (
                      <span className="text-xs px-2 py-0.5 rounded font-semibold bg-amber-100 text-amber-700">On-Campus</span>
                    ) : a.location === 'off_campus' ? (
                      <span className="text-xs px-2 py-0.5 rounded font-semibold bg-sky-100 text-sky-700">Off-Campus</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded font-medium bg-slate-100 text-slate-500">Any</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {a.assigned_at ? new Date(a.assigned_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => removeAssignment.mutate(a.id)}
                      disabled={removeAssignment.isPending}
                      className="text-xs text-red-500 hover:underline disabled:opacity-40">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main PolicyEditor
// ---------------------------------------------------------------------------
export default function PolicyEditor() {
  const { policyId } = useParams();
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
          {policy.is_network_policy && (
            <span className="ml-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
              DNS Network Floor
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
            {t === 'YouTube' && policy.youtube_categories?.mode && policy.youtube_categories.mode !== 'off' && policy.youtube_categories.mode !== 'restricted' && (
              <span className="ml-1.5 text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full">
                {policy.youtube_categories.mode}
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
          {tab === 4 && <YouTubeTab      policy={policy} policyId={policyId} />}
          {tab === 5 && <AssignmentsTab  policy={policy} policyId={policyId} />}
        </div>
      </div>
    </div>
  );
}
