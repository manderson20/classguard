import { useState, useEffect, useCallback } from 'react';
import api from '../../../lib/api';

const GRADE_META = {
  A: { bg: 'bg-green-100',  text: 'text-green-700',  border: 'border-green-200',  label: 'A' },
  B: { bg: 'bg-blue-100',   text: 'text-blue-700',   border: 'border-blue-200',   label: 'B' },
  C: { bg: 'bg-yellow-100', text: 'text-yellow-700', border: 'border-yellow-200', label: 'C' },
  D: { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200', label: 'D' },
  F: { bg: 'bg-red-100',    text: 'text-red-700',    border: 'border-red-200',    label: 'F' },
};

function GradeBadge({ grade, large }) {
  const m = GRADE_META[grade?.toUpperCase()] || { bg: 'bg-slate-100', text: 'text-slate-500', border: 'border-slate-200', label: grade || '—' };
  return (
    <span className={`inline-flex items-center justify-center font-bold rounded border ${m.bg} ${m.text} ${m.border} ${large ? 'w-14 h-14 text-2xl' : 'w-7 h-7 text-sm'}`}>
      {m.label}
    </span>
  );
}

function ProgressBar({ pct }) {
  const v = Math.min(100, Math.max(0, pct || 0));
  const color = v >= 80 ? 'bg-green-500' : v >= 50 ? 'bg-yellow-400' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-slate-100 rounded-full h-1.5 min-w-[60px] overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${v}%` }} />
      </div>
      <span className="text-xs text-slate-600 w-8 text-right">{Math.round(v)}%</span>
    </div>
  );
}

function PhishedBadge({ count }) {
  if (!count) return <span className="text-xs text-green-600 font-medium">None</span>;
  const color = count >= 3 ? 'text-red-600' : count >= 1 ? 'text-orange-600' : 'text-green-600';
  return <span className={`text-xs font-semibold ${color}`}>{count}×</span>;
}

function downloadExitTicket(email) {
  const token = localStorage.getItem('cg_token');
  fetch(`/api/v1/infoseciq/exit-ticket/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.blob()).then(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `exit-ticket-${email}.pdf`;
    a.click();
  });
}

function GradeCardModal({ learner, onClose }) {
  const [history, setHistory] = useState(null);

  useEffect(() => {
    if (!learner?.email) return;
    api.get(`/infoseciq/learners/by-email/${encodeURIComponent(learner.email)}`)
      .then(d => setHistory(d?.phishing_history || []))
      .catch(() => setHistory([]));
  }, [learner?.email]);

  if (!learner) return null;

  const stats = [
    { label: 'Grade Score',       value: learner.grade_score ? `${learner.grade_score}/100` : '—' },
    { label: 'Times Phished',     value: learner.phished_count ?? 0 },
    { label: 'Data Entry Events', value: learner.data_entry_count ?? 0 },
    { label: 'Modules Assigned',  value: learner.modules_enrolled ?? 0 },
    { label: 'Modules Completed', value: learner.modules_completed ?? 0 },
    { label: 'Assessments Passed',value: learner.assessments_passed ?? 0 },
    { label: 'Time Trained',      value: learner.training_time_minutes ? `${learner.training_time_minutes} min` : '—' },
    { label: 'Last Activity',     value: learner.last_activity_at ? new Date(learner.last_activity_at).toLocaleDateString() : '—' },
  ];

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="bg-slate-50 border-b border-slate-200 p-5 flex items-center gap-4">
          <GradeBadge grade={learner.letter_grade} large />
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-slate-900 text-lg leading-tight">
              {learner.first_name} {learner.last_name}
            </h2>
            <p className="text-sm text-slate-500 truncate">{learner.email}</p>
            {learner.department && (
              <span className="inline-block mt-1 text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">
                {learner.department}
              </span>
            )}
          </div>
          <button
            onClick={() => downloadExitTicket(learner.email)}
            className="text-xs px-3 py-1.5 rounded-lg bg-primary-600 text-white hover:bg-primary-700 font-medium whitespace-nowrap"
            title="Download exit ticket PDF for this staff member"
          >
            Exit Ticket PDF
          </button>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl font-bold px-2">×</button>
        </div>

        {/* Stats grid */}
        <div className="p-5">
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Training Completion</span>
              <span className="text-xs text-slate-600">{learner.modules_completed ?? 0} / {learner.modules_enrolled ?? 0} modules</span>
            </div>
            <ProgressBar pct={learner.training_completion_pct} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {stats.map(s => (
              <div key={s.label} className="bg-slate-50 rounded-lg px-3 py-2">
                <div className="text-xs text-slate-400 uppercase tracking-wide">{s.label}</div>
                <div className={`font-semibold text-sm mt-0.5 ${
                  s.label === 'Times Phished' && (s.value > 2) ? 'text-red-600' :
                  s.label === 'Times Phished' && (s.value > 0) ? 'text-orange-600' : 'text-slate-800'
                }`}>{s.value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Phishing history */}
        <div className="border-t border-slate-100 px-5 pb-5">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mt-4 mb-2">Phishing Campaign History</h3>
          {history === null ? (
            <p className="text-xs text-slate-400">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-xs text-slate-400">No phishing history recorded.</p>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {history.map((h, i) => (
                <div key={i} className="flex items-center gap-3 text-xs py-1.5 border-b border-slate-50 last:border-0">
                  <div className="flex-1 truncate font-medium text-slate-700">{h.campaign_name}</div>
                  <div className="flex gap-2 flex-shrink-0">
                    {h.clicked_at  && <span className="px-1.5 py-0.5 rounded bg-red-100    text-red-700    font-medium">Clicked</span>}
                    {h.opened_at   && !h.clicked_at && <span className="px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 font-medium">Opened</span>}
                    {h.reported_at && <span className="px-1.5 py-0.5 rounded bg-green-100  text-green-700  font-medium">Reported</span>}
                    {!h.clicked_at && !h.opened_at && !h.reported_at && <span className="text-slate-400">No action</span>}
                  </div>
                  <div className="text-slate-400 flex-shrink-0 w-20 text-right">
                    {h.sent_at ? new Date(h.sent_at).toLocaleDateString() : '—'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const SORT_COLS = [
  { key: 'last_name',               label: 'Name' },
  { key: 'letter_grade',            label: 'Grade' },
  { key: 'training_completion_pct', label: 'Training %' },
  { key: 'phished_count',           label: 'Phished' },
  { key: 'modules_completed',       label: 'Modules' },
  { key: 'training_time_minutes',   label: 'Time Trained' },
  { key: 'last_activity_at',        label: 'Last Active' },
];

export default function InfosecIqGradeCards() {
  const [data,          setData]       = useState(null);
  const [loading,       setLoading]    = useState(true);
  const [error,         setError]      = useState(null);
  const [q,             setQ]          = useState('');
  const [dept,          setDept]       = useState('');
  const [gradeFilter,   setGradeFilter]= useState('');
  const [sort,          setSort]       = useState('last_name');
  const [order,         setOrder]      = useState('asc');
  const [selected,      setSelected]   = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ sort, order, limit: 500 });
    if (q)           params.set('q', q);
    if (dept)        params.set('dept', dept);
    if (gradeFilter) params.set('grade', gradeFilter);
    api.get(`/infoseciq/grade-cards?${params}`)
      .then(setData)
      .catch(e => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [q, dept, gradeFilter, sort, order]);

  useEffect(() => { load(); }, [load]);

  const toggleSort = (key) => {
    if (sort === key) setOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setOrder(key === 'last_name' ? 'asc' : 'desc'); }
  };

  const cards       = data?.gradeCards   || [];
  const depts       = data?.departments  || [];
  const dist        = data?.distribution || [];

  const handleExport = () => {
    const token = localStorage.getItem('cg_token');
    const url = `/api/v1/infoseciq/grade-cards/export.csv`;
    const a = document.createElement('a');
    a.href = url;
    a.setAttribute('download', 'security-grade-cards.csv');
    // Use fetch to include auth header
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        a.href = URL.createObjectURL(blob);
        a.click();
      });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Security Grade Cards</h1>
          <p className="text-sm text-slate-500 mt-0.5">Per-staff security awareness grades from Infosec IQ</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExport} className="btn btn-secondary text-sm">
            Export CSV
          </button>
          <button
            onClick={() => {
              const token = localStorage.getItem('cg_token');
              fetch('/api/v1/infoseciq/exit-ticket/bulk', {
                headers: { Authorization: `Bearer ${token}` },
              }).then(r => r.blob()).then(blob => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `exit-tickets-all-${new Date().toISOString().slice(0,10)}.pdf`;
                a.click();
              });
            }}
            className="btn btn-primary text-sm"
          >
            All Exit Tickets PDF
          </button>
        </div>
      </div>

      {/* Grade distribution */}
      {dist.length > 0 && (
        <div className="flex gap-2 mb-5 flex-wrap">
          <button
            onClick={() => setGradeFilter('')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${!gradeFilter ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'}`}
          >
            All ({data?.total ?? 0})
          </button>
          {['A','B','C','D','F'].map(g => {
            const m   = GRADE_META[g];
            const cnt = dist.find(d => d.letter_grade === g)?.cnt ?? 0;
            if (!cnt) return null;
            return (
              <button
                key={g}
                onClick={() => setGradeFilter(gradeFilter === g ? '' : g)}
                className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
                  gradeFilter === g ? `${m.bg} ${m.text} ${m.border}` : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                }`}
              >
                {g} — {cnt}
              </button>
            );
          })}
        </div>
      )}

      {/* Search + dept filter */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          className="input flex-1 min-w-48"
          placeholder="Search by name or email…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        {depts.length > 0 && (
          <select className="input w-56" value={dept} onChange={e => setDept(e.target.value)}>
            <option value="">All Departments</option>
            {depts.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
      </div>

      {error && <div className="text-red-600 text-sm mb-4">{error}</div>}

      {loading ? (
        <div className="text-sm text-slate-400 py-12 text-center">Loading grade cards…</div>
      ) : cards.length === 0 ? (
        <div className="text-sm text-slate-400 py-12 text-center">
          No grade cards found. Run a sync in Integrations → Infosec IQ to populate data.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {SORT_COLS.map(col => (
                    <th
                      key={col.key}
                      className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide cursor-pointer hover:text-slate-700 select-none whitespace-nowrap"
                      onClick={() => toggleSort(col.key)}
                    >
                      {col.label}
                      {sort === col.key && <span className="ml-1">{order === 'asc' ? '↑' : '↓'}</span>}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Department</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cards.map(c => (
                  <tr
                    key={c.id}
                    className="hover:bg-slate-50 cursor-pointer transition-colors"
                    onClick={() => setSelected(c)}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{c.last_name}, {c.first_name}</div>
                      <div className="text-xs text-slate-400">{c.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      <GradeBadge grade={c.letter_grade} />
                    </td>
                    <td className="px-4 py-3 min-w-[140px]">
                      <ProgressBar pct={c.training_completion_pct} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <PhishedBadge count={c.phished_count} />
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {c.modules_completed ?? 0} / {c.modules_enrolled ?? 0}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {c.training_time_minutes ? `${c.training_time_minutes} min` : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {c.last_activity_at ? new Date(c.last_activity_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{c.department || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 border-t border-slate-100 text-xs text-slate-400">
            {cards.length} of {data?.total ?? 0} staff members
          </div>
        </div>
      )}

      {selected && <GradeCardModal learner={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
