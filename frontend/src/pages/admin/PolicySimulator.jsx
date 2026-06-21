import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../../lib/api';

const STEP_COLOR = {
  policy_resolved: 'text-slate-500',
  lesson_mode:     'text-purple-600',
  penalty_box:     'text-red-500',
  allow_list:      'text-green-600',
  deny_list:       'text-red-600',
  blocklist:       'text-red-600',
  category:        'text-amber-600',
  upstream:        'text-blue-600',
};

const STEP_ICON = {
  policy_resolved: '🔐',
  lesson_mode:     '📚',
  penalty_box:     '🚫',
  allow_list:      '✅',
  deny_list:       '🚫',
  blocklist:       '🛡️',
  category:        '🏷️',
  upstream:        '🌐',
};

function TraceStep({ step, index }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="flex-shrink-0 flex flex-col items-center">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
          step.hit ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-400'
        }`}>
          {index + 1}
        </div>
        {index < 100 && <div className="w-px flex-1 mt-1 bg-slate-200 min-h-[1rem]" />}
      </div>
      <div className={`pb-4 flex-1 ${step.hit ? '' : 'opacity-50'}`}>
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-base">{STEP_ICON[step.step] || '▸'}</span>
          <span className={`text-sm font-semibold capitalize ${STEP_COLOR[step.step] || 'text-slate-600'}`}>
            {step.step.replace(/_/g, ' ')}
          </span>
          {step.hit && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              step.result === 'allow' ? 'bg-green-100 text-green-700' :
              step.result === 'block' ? 'bg-red-100 text-red-700' :
              step.result === 'continue' ? 'bg-slate-100 text-slate-500' :
              'bg-blue-100 text-blue-700'
            }`}>
              {step.result}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 ml-6">{step.detail || '—'}</p>
      </div>
    </div>
  );
}

export default function PolicySimulator() {
  const [mode,       setMode]       = useState('resolve'); // 'resolve' | 'policy'
  const [studentId,  setStudentId]  = useState('');
  const [policyId,   setPolicyId]   = useState('');
  const [domain,     setDomain]     = useState('');
  const [sourceIp,   setSourceIp]   = useState('');
  const [result,     setResult]     = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');

  const { data: users = [] } = useQuery({
    queryKey: ['users-list'],
    queryFn:  () => api.get('/users?limit=500'),
    select:   d => (d.users || d || []).filter(u => u.role === 'student'),
  });

  const { data: policies = [] } = useQuery({
    queryKey: ['policies-list'],
    queryFn:  () => api.get('/policies'),
  });

  const run = async () => {
    if (!domain.trim()) { setError('Domain is required'); return; }
    if (mode === 'policy' && !policyId) { setError('Choose a policy to test against'); return; }
    setError('');
    setLoading(true);
    setResult(null);
    try {
      const body = { domain: domain.trim().toLowerCase() };
      if (mode === 'policy') {
        body.policy_id = policyId;
      } else {
        if (studentId) body.student_id = studentId;
        if (sourceIp)  body.source_ip  = sourceIp.trim();
      }
      const data = await api.post('/policies/simulate', body);
      setResult(data);
    } catch (e) {
      setError(e.message || 'Simulation failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-2 text-sm text-slate-500 mb-6">
        <Link to="/admin/policies" className="hover:text-primary-600 font-medium">Policies</Link>
        <span>›</span>
        <span className="text-slate-900 font-semibold">Filter Simulator</span>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-5">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Filter Simulator</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Test exactly how ClassGuard would handle a DNS request — step by step.
          </p>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode('resolve')}
            className={`flex-1 text-sm font-medium rounded-lg px-3 py-2 border transition-colors ${
              mode === 'resolve'
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}
          >
            Resolve automatically
            <span className="block text-xs font-normal opacity-75 mt-0.5">By student / source IP — what real traffic would get</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('policy')}
            className={`flex-1 text-sm font-medium rounded-lg px-3 py-2 border transition-colors ${
              mode === 'policy'
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}
          >
            Test a specific policy
            <span className="block text-xs font-normal opacity-75 mt-0.5">Skip resolution — check one policy's rules directly</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {mode === 'policy' ? (
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">
                Policy <span className="text-red-500">*</span>
              </label>
              <select
                className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full bg-white"
                value={policyId}
                onChange={e => setPolicyId(e.target.value)}
              >
                <option value="">— Choose a policy —</option>
                {policies.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.is_default ? ' (default)' : ''}{p.is_network_policy ? ' (network floor)' : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">
                  Student <span className="text-slate-400 font-normal normal-case">(optional)</span>
                </label>
                <select
                  className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full bg-white"
                  value={studentId}
                  onChange={e => setStudentId(e.target.value)}
                >
                  <option value="">— No student (district default policy) —</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.display_name || u.email} {u.ou_path ? `(${u.ou_path.split('/').pop()})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">
                  Source IP <span className="text-slate-400 font-normal normal-case">(optional)</span>
                </label>
                <input
                  className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full"
                  placeholder="192.168.1.50"
                  value={sourceIp}
                  onChange={e => setSourceIp(e.target.value)}
                />
                <p className="text-xs text-slate-400 mt-0.5">Used for subnet-based policy lookup</p>
              </div>
            </>
          )}
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">
              Domain to test <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <input
                className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 flex-1 font-mono"
                placeholder="e.g. example.com or cdn.tiktok.com"
                value={domain}
                onChange={e => setDomain(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !loading && run()}
              />
              <button
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 transition-colors disabled:opacity-40 whitespace-nowrap"
                onClick={run}
                disabled={loading || !domain.trim()}
              >
                {loading ? 'Running…' : '▶ Run Simulation'}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
            {error}
          </div>
        )}
      </div>

      {/* Results */}
      {result && (
        <div className="mt-6 space-y-4">
          {/* Verdict */}
          <div className={`rounded-xl border-2 p-5 ${
            result.blocked
              ? 'border-red-300 bg-red-50'
              : 'border-green-300 bg-green-50'
          }`}>
            <div className="flex items-center gap-3">
              <span className="text-3xl">{result.blocked ? '🚫' : '✅'}</span>
              <div>
                <div className={`text-xl font-bold ${result.blocked ? 'text-red-700' : 'text-green-700'}`}>
                  {result.blocked ? 'BLOCKED' : 'ALLOWED'}
                </div>
                <div className="text-sm text-slate-600 mt-0.5">
                  <span className="font-mono font-medium">{result.domain}</span>
                  {result.category && (
                    <span className="ml-2 text-xs bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded">
                      {result.category}
                    </span>
                  )}
                  {result.reason && (
                    <span className="ml-1 text-xs text-slate-500">— {result.reason}</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Trace */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">Decision Trace</h3>
            <div>
              {(result.trace || []).map((step, i) => (
                <TraceStep key={i} step={step} index={i} />
              ))}
            </div>
          </div>

          {/* Test more */}
          <div className="text-center">
            <button
              className="text-sm text-primary-600 hover:underline font-medium"
              onClick={() => { setResult(null); setDomain(''); }}
            >
              ← Test another domain
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
