import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      <span>{label}{hint && <span className="font-normal text-slate-400 ml-1">— {hint}</span>}</span>
      {children}
    </label>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color='slate' }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 text-center shadow-sm">
      <div className={`text-3xl font-bold text-${color}-600`}>{value}</div>
      <div className="text-xs text-slate-500 mt-1">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------
function OverviewTab({ status }) {
  const c = status?.counts || {};
  const classroom = status?.classroom || {};
  const sources   = status?.oneroster?.sources || [];

  return (
    <div className="flex flex-col gap-5">
      {/* Counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Google Classroom classes" value={c.classroom_classes||0} color="blue"/>
        <StatCard label="OneRoster classes"         value={c.oneroster_classes||0} color="green"/>
        <StatCard label="Total enrollments"         value={(parseInt(c.classroom_enrollments||0)+parseInt(c.oneroster_enrollments||0)).toLocaleString()} color="slate"/>
        <StatCard label="Synced users"              value={(parseInt(c.google_users||0)+parseInt(c.oneroster_users||0)).toLocaleString()} color="purple"/>
      </div>

      {/* Source summary cards */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* Google Classroom */}
        <div className={`bg-white border rounded-xl p-5 shadow-sm ${classroom.configured?'border-slate-200':'border-amber-200 bg-amber-50/30'}`}>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-2xl">🏫</span>
            <div>
              <div className="font-semibold text-slate-900">Google Classroom</div>
              <div className="text-xs text-slate-500">
                {classroom.configured ? 'Service account configured' : 'Not configured — needs GOOGLE_SERVICE_ACCOUNT_KEY_PATH'}
              </div>
            </div>
          </div>
          {classroom.last_sync && (
            <div className="text-xs text-slate-500 mb-2">Last sync: {new Date(classroom.last_sync).toLocaleString()}</div>
          )}
          <div className="text-xs text-slate-500 space-y-0.5">
            <div>{c.classroom_classes||0} classes · {c.classroom_enrollments||0} enrollments</div>
          </div>
        </div>

        {/* OneRoster */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-2xl">🏛️</span>
            <div>
              <div className="font-semibold text-slate-900">OneRoster / SIS</div>
              <div className="text-xs text-slate-500">{sources.length} source{sources.length!==1?'s':''} configured</div>
            </div>
          </div>
          <div className="space-y-1">
            {sources.map(s=>(
              <div key={s.id} className="flex items-center gap-2 text-xs">
                <span className={`w-2 h-2 rounded-full ${s.is_active?'bg-green-400':'bg-slate-300'}`}/>
                <span className="font-medium text-slate-700">{s.name}</span>
                {s.last_error && <span className="text-red-400 truncate max-w-xs">{s.last_error}</span>}
                {s.last_sync && !s.last_error && <span className="text-slate-400">{new Date(s.last_sync).toLocaleDateString()}</span>}
              </div>
            ))}
            {!sources.length && <p className="text-xs text-slate-400">No SIS sources added yet — add one in the OneRoster tab</p>}
          </div>
        </div>
      </div>

      {/* Setup guide */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">
        <h3 className="font-semibold text-slate-800 mb-3 text-sm">How roster sync works</h3>
        <div className="grid md:grid-cols-2 gap-4 text-sm text-slate-600">
          <div>
            <div className="font-medium text-slate-800 mb-1">Google Classroom</div>
            <ol className="space-y-1 list-decimal list-inside text-xs">
              <li>Set up a Google service account with domain-wide delegation</li>
              <li>Grant <code className="bg-slate-200 px-1 rounded">classroom.courses.readonly</code> + <code className="bg-slate-200 px-1 rounded">classroom.rosters.readonly</code></li>
              <li>Set <code className="bg-slate-200 px-1 rounded">GOOGLE_SERVICE_ACCOUNT_KEY_PATH</code> + <code className="bg-slate-200 px-1 rounded">SUPERADMIN_EMAIL</code> env vars</li>
              <li>Click <strong>Sync Now</strong> — classes and rosters auto-create</li>
            </ol>
          </div>
          <div>
            <div className="font-medium text-slate-800 mb-1">Infinite Campus / OneRoster SIS</div>
            <ol className="space-y-1 list-decimal list-inside text-xs">
              <li>In Infinite Campus: System Admin → Data Integrations → Campus API → OneRoster</li>
              <li>Create an API Key Pair (client ID + secret)</li>
              <li>Add the source in the OneRoster tab with your base URL</li>
              <li>Typical IC URL: <code className="bg-slate-200 px-1 rounded">https://campus.district.k12.xx/api/oneroster/v1p1</code></li>
              <li>Click <strong>Test Connection</strong>, then <strong>Sync Now</strong></li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Google Classroom tab
// ---------------------------------------------------------------------------
function ClassroomTab() {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  const { data: status = {} } = useQuery({
    queryKey: ['classroom-status'],
    queryFn:  () => api.get('/roster/classroom/status'),
    refetchInterval: 30_000,
  });

  const sync = async () => {
    setSyncing(true);
    try { await api.post('/roster/sync/classroom'); }
    finally { setTimeout(()=>{ setSyncing(false); qc.invalidateQueries({queryKey:['classroom-status']}); }, 2000); }
  };

  const mapped = status.mapped_courses || [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${status.configured?'bg-green-400':'bg-amber-400'}`}/>
          <span className="text-sm text-slate-600">{status.configured ? 'Service account configured' : 'Not configured'}</span>
        </div>
        {status.last_sync && (
          <span className="text-xs text-slate-400">Last sync: {new Date(status.last_sync).toLocaleString()}</span>
        )}
        <div className="ml-auto flex gap-2">
          <button onClick={sync} disabled={!status.configured||syncing}
            className="btn-primary text-sm disabled:opacity-50">
            {syncing?'Syncing…':'Sync Now'}
          </button>
        </div>
      </div>

      {!status.configured && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          Google Classroom sync requires a service account. Set <code className="bg-amber-100 px-1 rounded font-mono text-xs">GOOGLE_SERVICE_ACCOUNT_KEY_PATH</code> and <code className="bg-amber-100 px-1 rounded font-mono text-xs">SUPERADMIN_EMAIL</code> in your .env file, then restart the API.
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Classes synced"   value={status.counts?.classes||0}     color="blue"/>
        <StatCard label="Enrollments"      value={status.counts?.enrollments||0}  color="green"/>
        <StatCard label="Teachers/Students" value={status.counts?.users||0}       color="slate"/>
      </div>

      {/* Course map */}
      {mapped.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              <tr>{['Classroom Course','ClassGuard Class','Teacher','Last Sync'].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {mapped.map(m=>(
                <tr key={m.classroom_course_id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-xs font-mono text-slate-500">{m.classroom_course_id}</td>
                  <td className="px-3 py-2 text-sm font-medium text-slate-800">{m.class_name||'—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{m.teacher_email||'—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{m.last_sync?new Date(m.last_sync).toLocaleString():'—'}</td>
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
// OneRoster tab
// ---------------------------------------------------------------------------
const EMPTY_SOURCE = { name:'', base_url:'', client_id:'', client_secret:'', school_year:'', org_filter:'' };

function OneRosterTab() {
  const qc = useQueryClient();
  const [modal, setModal]   = useState(null);
  const [form, setForm]     = useState(EMPTY_SOURCE);
  const [testing, setTest]  = useState(null);
  const [testRes, setTestRes] = useState({});
  const [syncing, setSyncing] = useState(null);

  const { data: sources=[] } = useQuery({
    queryKey: ['oneroster-sources'],
    queryFn:  () => api.get('/roster/oneroster/sources'),
    refetchInterval: 15_000,
  });

  const add = useMutation({
    mutationFn: () => api.post('/roster/oneroster/sources', form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['oneroster-sources']}); setModal(null); },
  });

  const upd = useMutation({
    mutationFn: () => api.put(`/roster/oneroster/sources/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['oneroster-sources']}); setModal(null); },
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/roster/oneroster/sources/${id}`),
    onSuccess: () => qc.invalidateQueries({queryKey:['oneroster-sources']}),
  });

  const test = async (id) => {
    setTest(id);
    try {
      const r = await api.post(`/roster/oneroster/sources/${id}/test`);
      setTestRes(p=>({...p,[id]:{ok:true,orgs:r.orgs}}));
    } catch(e) {
      setTestRes(p=>({...p,[id]:{ok:false,error:e.message}}));
    }
    setTest(null);
  };

  const sync = async (id) => {
    setSyncing(id);
    try {
      await api.post(`/roster/sync/oneroster/${id}`);
      qc.invalidateQueries({queryKey:['oneroster-sources']});
    } catch(e) { alert('Sync failed: ' + e.message); }
    setTimeout(()=>setSyncing(null), 2000);
  };

  const syncAll = async () => {
    try { await api.post('/roster/sync/oneroster-all'); }
    catch(e) { alert('Sync failed: ' + e.message); }
  };

  const f = (k, v) => setForm(p => ({...p, [k]: v}));

  const SourceForm = () => (
    <div className="flex flex-col gap-3">
      <Field label="Source name" hint="e.g. Infinite Campus">
        <input className={INPUT} value={form.name} onChange={e=>f('name',e.target.value)} placeholder="Infinite Campus"/>
      </Field>
      <Field label="OneRoster base URL" hint="no trailing slash">
        <input className={INPUT} value={form.base_url} onChange={e=>f('base_url',e.target.value)}
          placeholder="https://campus.district.k12.us/api/oneroster/v1p1"/>
      </Field>
      <Field label="OAuth2 Client ID">
        <input className={INPUT} value={form.client_id} onChange={e=>f('client_id',e.target.value)}/>
      </Field>
      <Field label="OAuth2 Client Secret">
        <input type="password" className={INPUT} value={form.client_secret} onChange={e=>f('client_secret',e.target.value)}/>
      </Field>
      <Field label="School Year" hint="optional filter, e.g. 2025-2026">
        <input className={INPUT} value={form.school_year} onChange={e=>f('school_year',e.target.value)} placeholder="2025-2026"/>
      </Field>
      <div className="flex justify-end gap-2 mt-2">
        <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
        <button onClick={()=>modal==='add'?add.mutate():upd.mutate()} disabled={add.isPending||upd.isPending} className="btn-primary text-sm">
          {(add.isPending||upd.isPending)?'Saving…':'Save'}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="flex justify-end gap-2 mb-4">
        {sources.length > 1 && <button onClick={syncAll} className="btn-secondary text-sm">Sync All Sources</button>}
        <button onClick={()=>{setForm(EMPTY_SOURCE);setModal('add')}} className="btn-primary text-sm">+ Add SIS Source</button>
      </div>

      <div className="flex flex-col gap-3">
        {sources.map(s=>(
          <div key={s.id} className={`bg-white border rounded-xl p-5 shadow-sm ${s.last_error?'border-red-200':'border-slate-200'}`}>
            <div className="flex items-start gap-3">
              <span className="text-2xl">🏛️</span>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-900">{s.name}</span>
                  <span className={`w-2 h-2 rounded-full ${s.is_active?'bg-green-400':'bg-slate-300'}`}/>
                  {s.school_year && <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{s.school_year}</span>}
                </div>
                <div className="text-xs text-slate-400 mt-1 font-mono">{s.base_url}</div>
                <div className="text-xs text-slate-500 mt-1">
                  Last sync: {s.last_sync ? new Date(s.last_sync).toLocaleString() : 'Never'}
                </div>
                {s.last_error && <p className="text-xs text-red-500 mt-1">Error: {s.last_error}</p>}
                {testRes[s.id] && (
                  <div className="mt-2 text-xs">
                    {testRes[s.id].ok
                      ? <span className="text-green-600">✓ Connected — orgs: {testRes[s.id].orgs?.map(o=>o.name).join(', ')}</span>
                      : <span className="text-red-500">✗ {testRes[s.id].error}</span>}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1 items-end text-xs">
                <button onClick={()=>test(s.id)} disabled={testing===s.id} className="text-slate-500 hover:underline">
                  {testing===s.id?'Testing…':'Test'}
                </button>
                <button onClick={()=>sync(s.id)} disabled={syncing===s.id} className="text-primary-600 hover:underline">
                  {syncing===s.id?'Syncing…':'Sync Now'}
                </button>
                <button onClick={()=>{setForm({...s,client_secret:''});setModal(s)}} className="text-slate-500 hover:underline">Edit</button>
                <button onClick={()=>del.mutate(s.id)} className="text-red-500 hover:underline">Remove</button>
              </div>
            </div>
          </div>
        ))}
        {!sources.length && (
          <div className="text-center py-12 text-slate-400 text-sm">
            No OneRoster sources yet — add your SIS connection above.
          </div>
        )}
      </div>

      {modal && (
        <Modal title={modal==='add'?'Add OneRoster / SIS Source':'Edit Source'} onClose={()=>setModal(null)}>
          <SourceForm/>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = ['Overview','Google Classroom','OneRoster / SIS'];

export default function RosterPage() {
  const [tab, setTab] = useState('Overview');

  const { data: status = {} } = useQuery({
    queryKey: ['roster-status'],
    queryFn:  () => api.get('/roster/status'),
    refetchInterval: 30_000,
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">Roster Sync</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Auto-populate classes and rosters from Google Classroom or your SIS via OneRoster
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

      {tab==='Overview'           && <OverviewTab status={status}/>}
      {tab==='Google Classroom'   && <ClassroomTab/>}
      {tab==='OneRoster / SIS'    && <OneRosterTab/>}
    </div>
  );
}
