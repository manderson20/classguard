import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const INPUT  = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const SELECT = INPUT + ' bg-white';

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-xl shadow-xl ${wide ? 'w-full max-w-2xl' : 'w-full max-w-lg'} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

const RISK_COLOR = {
  high:   'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low:    'bg-slate-100 text-slate-600',
};

const ACTION_COLOR = {
  block:   'bg-red-100 text-red-700 border-red-200',
  allow:   'bg-green-100 text-green-700 border-green-200',
  monitor: 'bg-blue-100 text-blue-700 border-blue-200',
};

const TABS = ['Categories', 'Policy Rules', 'Domain Lookup', 'Sources'];

// ---------------------------------------------------------------------------
// Categories tab — grid of all categories with domain counts
// ---------------------------------------------------------------------------
function CategoriesTab({ categories }) {
  const [selected, setSelected] = useState(null);
  const [search, setSearch]     = useState('');
  const [domainSearch, setDS]   = useState('');
  const [page, setPage]         = useState(1);

  const { data: domainsData, isLoading: domsLoading } = useQuery({
    queryKey: ['cat-domains', selected?.slug, page, domainSearch],
    queryFn: () => api.get(`/categories/${selected.slug}/domains?page=${page}&limit=50${domainSearch ? `&search=${encodeURIComponent(domainSearch)}` : ''}`),
    enabled: !!selected,
  });

  const filteredCats = categories.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.slug.includes(search.toLowerCase())
  );

  if (selected) {
    return (
      <div>
        <button onClick={() => { setSelected(null); setDS(''); setPage(1); }}
          className="text-primary-600 hover:underline text-sm mb-4 flex items-center gap-1">
          ← All Categories
        </button>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">{selected.name}</h2>
            <p className="text-sm text-slate-500 mt-0.5">{selected.description}</p>
            <div className="flex gap-2 mt-1">
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${RISK_COLOR[selected.risk_level]}`}>
                {selected.risk_level} risk
              </span>
              <span className="text-xs text-slate-500">{selected.domain_count?.toLocaleString()} domains</span>
            </div>
          </div>
        </div>
        <input className={`${INPUT} max-w-sm mb-3`} placeholder="Search domains…"
          value={domainSearch} onChange={e => { setDS(e.target.value); setPage(1); }} />
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>{['Domain','Source','Confidence','Override','Added'].map(h =>
                <th key={h} className="px-3 py-2 text-left">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {domsLoading && <tr><td colSpan={5} className="text-center py-8 text-slate-400">Loading…</td></tr>}
              {!domsLoading && domainsData?.domains.map(d => (
                <tr key={d.domain} className={`hover:bg-slate-50 ${d.is_override ? 'bg-amber-50/30' : ''}`}>
                  <td className="px-3 py-2 font-mono text-slate-800">{d.domain}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 capitalize">{d.source}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{d.confidence}%</td>
                  <td className="px-3 py-2 text-xs">{d.is_override && <span className="text-amber-600 font-medium">Manual</span>}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{new Date(d.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {!domsLoading && !domainsData?.domains.length && (
                <tr><td colSpan={5} className="text-center py-8 text-slate-400">No domains yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {domainsData && domainsData.total > 50 && (
          <div className="flex items-center justify-between mt-3 text-sm">
            <span className="text-slate-500">{domainsData.total.toLocaleString()} total</span>
            <div className="flex gap-2">
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="btn-secondary text-xs disabled:opacity-40">← Prev</button>
              <span className="px-2 py-1 text-slate-600">Page {page}</span>
              <button disabled={page * 50 >= domainsData.total} onClick={() => setPage(p => p + 1)} className="btn-secondary text-xs disabled:opacity-40">Next →</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <input className={`${INPUT} max-w-sm mb-4`} placeholder="Filter categories…"
        value={search} onChange={e => setSearch(e.target.value)} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredCats.map(c => (
          <button key={c.id} onClick={() => setSelected(c)}
            className="text-left border border-slate-200 rounded-xl p-4 hover:border-primary-300 hover:bg-primary-50/20 transition-colors bg-white shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <span className="font-semibold text-slate-800">{c.name}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${RISK_COLOR[c.risk_level]} flex-shrink-0`}>
                {c.risk_level}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">{c.description}</p>
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs font-medium text-slate-600">
                {(c.domain_count || 0).toLocaleString()} domains
              </span>
              {c.is_blocked_default && (
                <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-semibold">
                  Default block
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy Rules tab
// ---------------------------------------------------------------------------
function PolicyRulesTab({ categories }) {
  const qc = useQueryClient();
  const [policyId, setPolicyId] = useState('');

  const { data: policies = [] } = useQuery({
    queryKey: ['policies-list'],
    queryFn: () => api.get('/policies'),
  });

  const { data: rules = [], refetch } = useQuery({
    queryKey: ['cat-policy-rules', policyId],
    queryFn: () => api.get(`/categories/policy-rules${policyId ? `?policy_id=${policyId}` : ''}`),
  });

  const upsert = useMutation({
    mutationFn: body => api.put('/categories/policy-rules', body),
    onSuccess: () => refetch(),
  });
  const del = useMutation({
    mutationFn: id => api.delete(`/categories/policy-rules/${id}`),
    onSuccess: () => refetch(),
  });

  const [addSlug, setAddSlug] = useState('');
  const [addAction, setAddAction] = useState('block');

  const rulesByPolicy = rules.reduce((acc, r) => {
    if (!acc[r.policy_id]) acc[r.policy_id] = { name: r.policy_name, rules: [] };
    acc[r.policy_id].rules.push(r);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-700">
        Category rules apply during DNS filtering. <strong>Block</strong> — domains in this category are NXDOMAIN'd.{' '}
        <strong>Allow</strong> — always allowed even if on a blocklist.{' '}
        <strong>Monitor</strong> — logged but not blocked.
      </div>

      {/* Add rule */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h3 className="font-semibold text-slate-800 mb-3">Add Category Rule</h3>
        <div className="flex gap-3 flex-wrap">
          <select className={`${SELECT} w-48`} value={policyId}
            onChange={e => setPolicyId(e.target.value)}>
            <option value="">All policies</option>
            {policies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className={`${SELECT} w-52`} value={addSlug} onChange={e => setAddSlug(e.target.value)}>
            <option value="">Select category…</option>
            {categories.map(c => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
          <select className={`${SELECT} w-36`} value={addAction} onChange={e => setAddAction(e.target.value)}>
            <option value="block">Block</option>
            <option value="allow">Allow</option>
            <option value="monitor">Monitor</option>
          </select>
          <button
            onClick={() => { if (policyId && addSlug) { upsert.mutate({ policy_id: policyId, category_slug: addSlug, action: addAction }); setAddSlug(''); } }}
            disabled={!policyId || !addSlug || upsert.isPending}
            className="btn-primary text-sm">
            Add Rule
          </button>
        </div>
        {!policyId && <p className="text-xs text-amber-600 mt-2">Select a policy to add a rule to it.</p>}
      </div>

      {/* Rules table */}
      {Object.entries(rulesByPolicy).map(([pid, { name, rules: pRules }]) => (
        <div key={pid} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
            <span className="font-semibold text-slate-800">{name}</span>
            <span className="ml-2 text-xs text-slate-500">{pRules.length} rule{pRules.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="divide-y divide-slate-100">
            {pRules.map(r => (
              <div key={r.id} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded border font-semibold ${ACTION_COLOR[r.action]}`}>
                    {r.action.toUpperCase()}
                  </span>
                  <span className="text-sm font-medium text-slate-700">{r.category_name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${RISK_COLOR[r.risk_level]}`}>
                    {r.risk_level}
                  </span>
                </div>
                <div className="flex gap-2 items-center">
                  {['block','allow','monitor'].filter(a => a !== r.action).map(a => (
                    <button key={a} onClick={() => upsert.mutate({ policy_id: pid, category_slug: r.slug, action: a })}
                      className="text-xs text-slate-400 hover:text-slate-700 capitalize">{a}</button>
                  ))}
                  <button onClick={() => del.mutate(r.id)}
                    className="text-xs text-red-400 hover:text-red-600 ml-1">Remove</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!Object.keys(rulesByPolicy).length && (
        <div className="text-center py-10 text-slate-400 text-sm">
          No category rules yet — add one above to start blocking or monitoring by category.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Domain Lookup tab
// ---------------------------------------------------------------------------
function DomainLookupTab({ categories }) {
  const qc = useQueryClient();
  const [domain, setDomain] = useState('');
  const [query_, setQuery]  = useState('');
  const [overrideSlug, setOverrideSlug] = useState('');
  const [overrideOpen, setOverrideOpen] = useState(false);

  const { data: result, isFetching } = useQuery({
    queryKey: ['cat-lookup', query_],
    queryFn:  () => api.get(`/categories/lookup?domain=${encodeURIComponent(query_)}`),
    enabled:  !!query_,
  });

  const override = useMutation({
    mutationFn: body => api.post('/categories/override', body),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['cat-lookup', query_] }); setOverrideOpen(false); },
  });
  const removeOverride = useMutation({
    mutationFn: () => api.post('/categories/override', { domain: query_, remove: true }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['cat-lookup', query_] }),
  });

  const cat = result?.category ? categories.find(c => c.slug === result.category) : null;

  return (
    <div className="max-w-xl space-y-4">
      <form onSubmit={e => { e.preventDefault(); setQuery(domain.trim()); }} className="flex gap-2">
        <input className={INPUT} value={domain} onChange={e => setDomain(e.target.value)}
          placeholder="e.g. reddit.com or sub.example.com" />
        <button type="submit" className="btn-primary text-sm flex-shrink-0">Look up</button>
      </form>

      {isFetching && <p className="text-sm text-slate-400">Looking up…</p>}

      {!isFetching && result && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <span className="font-mono text-slate-700 text-lg">{result.domain}</span>
              {result.category ? (
                <div className="flex items-center gap-2 mt-2">
                  <span className={`text-sm font-semibold px-2.5 py-1 rounded-lg ${RISK_COLOR[result.risk_level] || 'bg-slate-100 text-slate-600'}`}>
                    {result.category_name || result.category}
                  </span>
                  <span className="text-xs text-slate-500">via {result.source}</span>
                  {result.confidence && <span className="text-xs text-slate-400">{result.confidence}% confidence</span>}
                  {result.is_override && <span className="text-xs text-amber-600 font-semibold">Manual override</span>}
                </div>
              ) : (
                <div className="mt-2 text-sm text-slate-400">No category assigned — not in any list</div>
              )}
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button onClick={() => setOverrideOpen(true)} className="btn-secondary text-xs">
                {result.is_override ? 'Change override' : 'Set category'}
              </button>
              {result.is_override && (
                <button onClick={() => removeOverride.mutate()} className="text-xs text-red-500 hover:underline">
                  Remove override
                </button>
              )}
            </div>
          </div>

          {result.records?.length > 1 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">All records</p>
              <div className="space-y-1">
                {result.records.map((r, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs text-slate-600 py-1 border-b border-slate-100 last:border-0">
                    <span className="font-mono text-slate-500">{r.domain}</span>
                    <span className="font-medium">{r.slug}</span>
                    <span className="text-slate-400">{r.source} · {r.confidence}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {overrideOpen && (
        <Modal title={`Set Category for ${query_}`} onClose={() => setOverrideOpen(false)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Manual overrides take priority over all imported lists.
            </p>
            <select className={SELECT} value={overrideSlug} onChange={e => setOverrideSlug(e.target.value)}>
              <option value="">Select category…</option>
              {categories.map(c => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
            <div className="flex justify-end gap-2">
              <button onClick={() => setOverrideOpen(false)} className="btn-secondary text-sm">Cancel</button>
              <button
                onClick={() => override.mutate({ domain: query_, category_slug: overrideSlug })}
                disabled={!overrideSlug || override.isPending}
                className="btn-primary text-sm">
                {override.isPending ? 'Saving…' : 'Save Override'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {!isFetching && !result && query_ && (
        <p className="text-sm text-slate-400">No result returned.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase label helper
// ---------------------------------------------------------------------------
const PHASE_LABEL = {
  queued:          'Queued',
  downloading:     'Downloading…',
  extracting:      'Extracting archive…',
  parsing:         'Parsing domain files…',
  importing:       'Importing to database…',
  done:            'Done',
  error:           'Error',
  rebuilding_cache:'Building Redis cache…',
  starting:        'Starting…',
};

function PhaseIndicator({ phase, error, domains, pairs, fileSizeMb }) {
  const isDone  = phase === 'done';
  const isError = phase === 'error';
  const isActive = !isDone && !isError && phase !== 'queued';
  return (
    <div className={`flex items-center gap-2 text-xs px-2.5 py-1 rounded-full border font-medium
      ${isDone  ? 'bg-green-50 border-green-200 text-green-700' :
        isError ? 'bg-red-50 border-red-200 text-red-600' :
        isActive ? 'bg-blue-50 border-blue-200 text-blue-700' :
                   'bg-slate-50 border-slate-200 text-slate-500'}`}>
      {isActive && (
        <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse flex-shrink-0" />
      )}
      <span>{PHASE_LABEL[phase] || phase}</span>
      {fileSizeMb && phase === 'extracting' && <span className="opacity-70">({fileSizeMb} MB)</span>}
      {pairs && phase === 'importing' && <span className="opacity-70">({pairs.toLocaleString()} domains)</span>}
      {isDone && domains != null && <span className="opacity-70">({domains.toLocaleString()} domains)</span>}
      {error && <span className="opacity-70 truncate max-w-[200px]">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources tab
// ---------------------------------------------------------------------------
function SourcesTab() {
  const qc = useQueryClient();

  const { data: sourcesData, isLoading } = useQuery({
    queryKey: ['cat-sources'],
    queryFn:  () => api.get('/categories/sources'),
  });

  // Poll sync status — fast when running, idle when not
  const { data: syncStatus = {} } = useQuery({
    queryKey: ['cat-sync-status'],
    queryFn:  () => api.get('/categories/sync-status'),
    refetchInterval: d => d?.running ? 2000 : 10000,
  });

  // Refresh sources table when sync finishes
  const wasRunning = syncStatus.running;
  if (!wasRunning && syncStatus.phase === 'done') {
    qc.invalidateQueries({ queryKey: ['cat-sources'] });
    qc.invalidateQueries({ queryKey: ['categories'] });
  }

  const sync = useMutation({
    mutationFn: source => api.post('/categories/sync', source ? { source } : {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['cat-sync-status'] }),
  });

  const classify = useMutation({
    mutationFn: () => api.post('/categories/classify-recent', { limit: 1000 }),
  });

  const rebuild = useMutation({
    mutationFn: () => api.post('/categories/rebuild-cache', {}),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['cat-sources'] }); qc.invalidateQueries({ queryKey: ['cat-sync-status'] }); },
  });

  const isRunning = syncStatus.running;

  return (
    <div className="space-y-5">

      {/* Live sync status banner */}
      {(isRunning || syncStatus.phase === 'done' || syncStatus.phase === 'error') && (
        <div className={`rounded-xl border p-4 ${
          isRunning         ? 'bg-blue-50 border-blue-200' :
          syncStatus.phase === 'error' ? 'bg-red-50 border-red-200' :
                             'bg-green-50 border-green-200'}`}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              {isRunning && <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />}
              <span className={`font-semibold text-sm ${isRunning ? 'text-blue-800' : syncStatus.phase === 'error' ? 'text-red-700' : 'text-green-800'}`}>
                {isRunning ? 'Sync in progress…' : syncStatus.phase === 'done' ? 'Sync complete' : 'Sync failed'}
              </span>
              {syncStatus.started_at && (
                <span className="text-xs text-slate-500">
                  Started {new Date(syncStatus.started_at).toLocaleTimeString()}
                </span>
              )}
            </div>
            {syncStatus.completed_at && (
              <span className="text-xs text-slate-500">
                Finished {new Date(syncStatus.completed_at).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Per-source status */}
          {syncStatus.sources && (
            <div className="space-y-2">
              {Object.entries(syncStatus.sources).map(([slug, s]) => (
                <div key={slug} className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-slate-600 w-24 flex-shrink-0 uppercase">{slug}</span>
                  <PhaseIndicator phase={s.phase} error={s.error} domains={s.domains}
                    pairs={s.pairs} fileSizeMb={s.file_size_mb} />
                </div>
              ))}
            </div>
          )}

          {/* Rebuilding cache / done totals */}
          {(syncStatus.phase === 'rebuilding_cache' || syncStatus.phase === 'done') && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-600 w-24 flex-shrink-0">Cache</span>
              <PhaseIndicator
                phase={syncStatus.phase === 'rebuilding_cache' ? 'rebuilding_cache' : 'done'}
                domains={syncStatus.cache_size}
              />
            </div>
          )}
        </div>
      )}

      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
        Category lists are downloaded from external servers. The first sync may take several minutes
        and import millions of domains. Syncs run automatically every Sunday at 3am.
      </div>

      <div className="flex gap-3 flex-wrap">
        <button onClick={() => sync.mutate(null)} disabled={isRunning || sync.isPending} className="btn-primary text-sm">
          {isRunning ? 'Sync running…' : 'Sync All Sources'}
        </button>
        <button onClick={() => classify.mutate()} disabled={classify.isPending} className="btn-secondary text-sm">
          {classify.isPending ? 'Running…' : 'Run Keyword Classifier'}
        </button>
        <button onClick={() => rebuild.mutate()} disabled={rebuild.isPending} className="btn-secondary text-sm">
          {rebuild.isPending ? 'Rebuilding…' : 'Rebuild Redis Cache'}
        </button>
      </div>

      {classify.data && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2.5 text-sm text-green-700">
          Keyword classifier: {classify.data.classified} new domains classified.
        </div>
      )}

      {rebuild.data && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2.5 text-sm text-green-700">
          Redis cache rebuilt — {rebuild.data.cacheSize?.toLocaleString()} domains cached.
        </div>
      )}

      {isLoading ? <p className="text-sm text-slate-400">Loading…</p> : (
        <>
          <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm">
            <span className="font-semibold text-slate-700">Redis cache:</span>{' '}
            <span className="font-mono text-primary-700">{(sourcesData?.cacheSize || 0).toLocaleString()}</span>{' '}
            <span className="text-slate-500">domains available for real-time DNS filtering</span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
                <tr>{['Source','Origin','Last Synced','Domains Imported','Status',''].map(h =>
                  <th key={h} className="px-3 py-2 text-left">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sourcesData?.sources.map(s => {
                  const live = syncStatus.sources?.[s.slug];
                  return (
                    <tr key={s.id} className={`hover:bg-slate-50 ${!s.is_active ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-800">{s.name}</div>
                        <div className="text-xs text-slate-400 font-mono truncate max-w-[220px]">{s.url}</div>
                        {!s.is_active && <span className="text-xs text-amber-600 font-medium">Disabled</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                        {s.origin || '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {s.last_synced_at ? new Date(s.last_synced_at).toLocaleString() : <span className="text-slate-300">Never</span>}
                      </td>
                      <td className="px-3 py-2 text-sm font-medium text-slate-700">
                        {(s.domain_count || 0).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        {live ? (
                          <PhaseIndicator phase={live.phase} error={live.error}
                            domains={live.domains} pairs={live.pairs} fileSizeMb={live.file_size_mb} />
                        ) : (
                          <span className="text-xs text-slate-400">{s.last_synced_at ? 'Up to date' : 'Not synced'}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => sync.mutate({ source: s.slug })}
                          disabled={isRunning || sync.isPending}
                          className="text-xs text-primary-600 hover:underline disabled:opacity-40">
                          Sync now
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <h3 className="font-semibold text-slate-700 mb-2 text-sm">How categorization works</h3>
            <ol className="text-sm text-slate-500 space-y-1.5 list-decimal list-inside">
              <li><strong className="text-slate-700">UT1 Blacklists (France)</strong> — 5.6M+ pre-categorized domains across 25 categories, updated weekly</li>
              <li><strong className="text-slate-700">Hagezi Blocklists (Germany)</strong> — supplemental adult + comprehensive threat intelligence list</li>
              <li><strong className="text-slate-700">URLhaus / OpenPhish</strong> — live malware and phishing domains updated daily (abuse.ch / USA)</li>
              <li><strong className="text-slate-700">Keyword classifier</strong> — pattern matches new domain names seen in DNS logs daily (e.g. "casino-poker.com" → gambling)</li>
              <li><strong className="text-slate-700">Manual overrides</strong> — admin-set in Domain Lookup tab, take priority over all other sources</li>
            </ol>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function ContentCategories() {
  const [tab, setTab] = useState('Categories');

  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn:  () => api.get('/categories'),
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">Content Categories</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Website taxonomy for DNS filtering — block, allow, or monitor by category per policy
        </p>
      </div>

      {/* Stats strip */}
      {!isLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Total categories', value: categories.length },
            { label: 'Total domains', value: categories.reduce((s, c) => s + (c.domain_count || 0), 0).toLocaleString() },
            { label: 'High-risk categories', value: categories.filter(c => c.risk_level === 'high').length },
            { label: 'Default-blocked', value: categories.filter(c => c.is_blocked_default).length },
          ].map(s => (
            <div key={s.label} className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
              <div className="text-xl font-bold text-slate-900">{s.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-200 mb-5">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors
              ${tab === t
                ? 'bg-white border border-b-white border-slate-200 text-primary-700 -mb-px'
                : 'text-slate-500 hover:text-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-slate-400 text-sm">Loading categories…</p>
      ) : (
        <>
          {tab === 'Categories'   && <CategoriesTab categories={categories} />}
          {tab === 'Policy Rules' && <PolicyRulesTab categories={categories} />}
          {tab === 'Domain Lookup'&& <DomainLookupTab categories={categories} />}
          {tab === 'Sources'      && <SourcesTab />}
        </>
      )}
    </div>
  );
}
