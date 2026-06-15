import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}{children}
    </label>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const CAT_COLOR = {
  education: 'green', reference: 'blue', productivity: 'blue',
  news: 'yellow', social_media: 'orange', gaming: 'red',
  streaming: 'orange', shopping: 'slate', adult: 'red',
  advertising: 'slate', security: 'purple', unknown: 'slate',
};

function CatBadge({ cat }) {
  const c = CAT_COLOR[cat] || 'slate';
  return <span className={`px-2 py-0.5 rounded text-xs font-medium bg-${c}-100 text-${c}-700`}>{cat}</span>;
}

// ---------------------------------------------------------------------------
// AI Settings section
// ---------------------------------------------------------------------------
function AiSettings() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ ai_provider:'claude', ai_api_key:'', ai_model:'', ai_base_url:'' });
  const [saved, setSaved] = useState(false);

  const save = async () => {
    await api.put('/settings', form);
    setSaved(true);
    setTimeout(()=>setSaved(false), 2000);
    qc.invalidateQueries({queryKey:['settings']});
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col gap-4">
      <h3 className="font-semibold text-slate-800">AI Provider Configuration</h3>
      <p className="text-xs text-slate-500">
        The AI classifier sends <strong>only the bare domain name</strong> to the provider — no student
        identifiers, IP addresses, or query timestamps leave the server.
        Results are cached permanently so each domain is classified once.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider">
          <select className={INPUT} value={form.ai_provider} onChange={e=>setForm(f=>({...f,ai_provider:e.target.value}))}>
            <option value="claude">Claude (Anthropic)</option>
            <option value="openai">OpenAI / Compatible</option>
            <option value="ollama">Ollama (local)</option>
          </select>
        </Field>
        <Field label="Model (leave blank for default)">
          <input className={INPUT} value={form.ai_model} onChange={e=>setForm(f=>({...f,ai_model:e.target.value}))}
            placeholder={form.ai_provider==='claude'?'claude-haiku-4-5-20251001':form.ai_provider==='openai'?'gpt-4o-mini':'llama3.2'}/>
        </Field>
        {form.ai_provider !== 'ollama' && (
          <Field label="API Key">
            <input type="password" className={INPUT} value={form.ai_api_key} onChange={e=>setForm(f=>({...f,ai_api_key:e.target.value}))}/>
          </Field>
        )}
        {(form.ai_provider === 'ollama' || form.ai_provider === 'openai') && (
          <Field label={form.ai_provider==='ollama'?'Ollama URL':'API Base URL (for OpenAI-compatible)'}
>            <input className={INPUT} value={form.ai_base_url} onChange={e=>setForm(f=>({...f,ai_base_url:e.target.value}))}
              placeholder={form.ai_provider==='ollama'?'http://localhost:11434':'https://api.openai.com'}/>
          </Field>
        )}
      </div>
      <div className="flex gap-2">
        <button onClick={save} className="btn-primary text-sm">{saved?'Saved!':'Save Settings'}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Classifications tab
// ---------------------------------------------------------------------------
function ClassificationsTab() {
  const qc = useQueryClient();
  const [domain, setDomain] = useState('');
  const [classifying, setClassifying] = useState(false);
  const [result, setResult] = useState(null);
  const [catFilter, setCatFilter] = useState('');

  const { data = {}, isLoading } = useQuery({
    queryKey: ['classifications', catFilter],
    queryFn: () => api.get(`/ai/classifications${catFilter?`?category=${catFilter}`:''}`),
  });

  const { data: stats = [] } = useQuery({
    queryKey: ['ai-stats'],
    queryFn: () => api.get('/ai/stats'),
  });

  const classify = async () => {
    if (!domain.trim()) return;
    setClassifying(true);
    setResult(null);
    try {
      const r = await api.post('/ai/classify', { domain: domain.trim() });
      setResult(r);
      qc.invalidateQueries({queryKey:['classifications']});
      qc.invalidateQueries({queryKey:['ai-stats']});
    } catch(e) { setResult({ error: e.message }); }
    finally { setClassifying(false); }
  };

  const del = useMutation({
    mutationFn: d => api.delete(`/ai/classifications/${d}`),
    onSuccess: () => qc.invalidateQueries({queryKey:['classifications']}),
  });

  const classifications = data.classifications || [];

  return (
    <div className="flex flex-col gap-5">
      {/* Category stats */}
      {stats.length > 0 && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          {stats.slice(0,6).map(s=>(
            <div key={s.category} className="bg-white border border-slate-200 rounded-lg p-3 text-center shadow-sm">
              <div className="text-xl font-bold text-slate-800">{s.total}</div>
              <CatBadge cat={s.category}/>
            </div>
          ))}
        </div>
      )}

      {/* Classify on demand */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <div className="text-sm font-semibold text-slate-800 mb-3">Classify a domain</div>
        <div className="flex gap-2">
          <input value={domain} onChange={e=>setDomain(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&classify()}
            placeholder="example.com" className={`${INPUT} flex-1`}/>
          <button onClick={classify} disabled={classifying} className="btn-primary text-sm whitespace-nowrap">
            {classifying?'Classifying…':'Classify'}
          </button>
        </div>
        {result && !result.error && (
          <div className="mt-3 p-3 bg-slate-50 rounded-lg text-xs flex flex-wrap gap-3 items-center">
            <CatBadge cat={result.category}/>
            {result.is_educational && <span className="text-green-600 font-medium">Educational</span>}
            {result.is_time_wasting && <span className="text-red-500 font-medium">Time-wasting</span>}
            {result.is_productive  && <span className="text-blue-600 font-medium">Productive</span>}
            <span className="text-slate-500">Confidence: {Math.round((result.confidence||0)*100)}%</span>
            {result.reasoning && <span className="text-slate-500 italic">{result.reasoning}</span>}
          </div>
        )}
        {result?.error && <p className="mt-2 text-xs text-red-500">{result.error}</p>}
      </div>

      {/* Filter + table */}
      <div className="flex items-center gap-3">
        <select value={catFilter} onChange={e=>setCatFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none">
          <option value="">All categories</option>
          {['education','reference','productivity','news','social_media','gaming','streaming','shopping','adult','advertising','security','unknown'].map(c=>(
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <span className="text-sm text-slate-500">{data.total || 0} classified domains</span>
      </div>

      {isLoading ? <p className="text-sm text-slate-400">Loading…</p> : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>{['Domain','Category','Educational','Time-Wasting','Confidence','By','Classified',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {classifications.map(c=>(
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs text-slate-800">{c.domain}</td>
                  <td className="px-3 py-2"><CatBadge cat={c.category}/></td>
                  <td className="px-3 py-2 text-center">{c.is_educational?'✓':''}</td>
                  <td className="px-3 py-2 text-center text-red-500">{c.is_time_wasting?'✓':''}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{Math.round((c.confidence||0)*100)}%</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{c.classified_by}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{new Date(c.classified_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    <button onClick={()=>del.mutate(c.domain)} className="text-xs text-red-500 hover:underline">Del</button>
                  </td>
                </tr>
              ))}
              {!classifications.length && <tr><td colSpan={8} className="text-center text-slate-400 py-8">No classifications yet</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Allowlist tab
// ---------------------------------------------------------------------------
function AllowlistTab() {
  const qc = useQueryClient();
  const [form, setForm]   = useState({ domain:'', notes:'' });
  const [addModal, setAddModal] = useState(false);
  const [syncing, setSyncing]   = useState(false);

  const { data: entries = [] } = useQuery({
    queryKey: ['ai-allowlist'],
    queryFn: () => api.get('/ai/allowlist'),
  });

  const add = useMutation({
    mutationFn: () => api.post('/ai/allowlist', form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['ai-allowlist']}); setAddModal(false); setForm({domain:'',notes:''}); },
  });

  const del = useMutation({
    mutationFn: d => api.delete(`/ai/allowlist/${encodeURIComponent(d)}`),
    onSuccess: () => qc.invalidateQueries({queryKey:['ai-allowlist']}),
  });

  const syncBookmarks = async () => {
    setSyncing(true);
    try {
      const r = await api.post('/ai/sync-bookmarks');
      alert(`Synced ${r.added} domains from managed bookmarks`);
      qc.invalidateQueries({queryKey:['ai-allowlist']});
    } catch(e) { alert('Sync failed: ' + e.message); }
    finally { setSyncing(false); }
  };

  const SOURCE_COLOR = { managed_bookmarks:'blue', manual:'green', ai_suggested:'purple' };

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
        <strong>Global allowlist overrides ALL blocks</strong> — including lesson mode and penalty box.
        Use this for managed bookmarks and admin-approved domains that must always be accessible.
        Managed bookmarks are synced from Google Admin automatically.
      </div>
      <div className="flex gap-2">
        <button onClick={syncBookmarks} disabled={syncing}
          className="btn-secondary text-sm disabled:opacity-50">
          {syncing?'Syncing…':'Sync Google Managed Bookmarks'}
        </button>
        <button onClick={()=>setAddModal(true)} className="btn-primary text-sm">+ Add Domain</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Domain','Source','Notes','Added',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.map(e=>{
              const c = SOURCE_COLOR[e.source]||'slate';
              return (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs text-slate-800">{e.domain}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs bg-${c}-100 text-${c}-700`}>{e.source}</span></td>
                  <td className="px-3 py-2 text-xs text-slate-500">{e.notes||'—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{new Date(e.added_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    {e.source === 'manual' && (
                      <button onClick={()=>del.mutate(e.domain)} className="text-xs text-red-500 hover:underline">Remove</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!entries.length && <tr><td colSpan={5} className="text-center text-slate-400 py-8">No allowlist overrides</td></tr>}
          </tbody>
        </table>
      </div>
      {addModal && (
        <Modal title="Add to Global Allowlist" onClose={()=>setAddModal(false)}>
          <div className="flex flex-col gap-3">
            <Field label="Domain (e.g. khanacademy.org)">
              <input className={INPUT} value={form.domain} onChange={e=>setForm(f=>({...f,domain:e.target.value}))}/>
            </Field>
            <Field label="Notes (optional)">
              <input className={INPUT} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))}/>
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setAddModal(false)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>add.mutate()} disabled={add.isPending} className="btn-primary text-sm">
              {add.isPending?'Adding…':'Add'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = ['Classifications','Global Allowlist','AI Settings'];

export default function AiPage() {
  const [tab, setTab] = useState('Classifications');

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">AI Content Classification</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Classify websites as educational, time-wasting, or productive.
          Only domain names are sent to the AI provider — no student data leaves the server.
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-5">
        {TABS.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors
              ${tab===t ? 'bg-white border border-b-white border-slate-200 text-primary-700 -mb-px' : 'text-slate-500 hover:text-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab==='Classifications'  && <ClassificationsTab/>}
      {tab==='Global Allowlist' && <AllowlistTab/>}
      {tab==='AI Settings'      && <AiSettings/>}
    </div>
  );
}
