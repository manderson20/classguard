import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../../lib/api';

function riskColor(score) {
  if (score > 60) return 'bg-red-100 text-red-700';
  if (score > 30) return 'bg-yellow-100 text-yellow-700';
  return 'bg-green-100 text-green-700';
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function ProgressBar({ pct }) {
  const clamped = Math.min(100, Math.max(0, pct || 0));
  const color = clamped >= 80 ? 'bg-green-500' : clamped >= 40 ? 'bg-yellow-400' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-slate-100 rounded-full h-1.5 overflow-hidden min-w-[60px]">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-xs text-slate-600 w-8 text-right">{Math.round(clamped)}%</span>
    </div>
  );
}

function PhishingHistoryRow({ learner }) {
  const [history, setHistory]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  useEffect(() => {
    api.get(`/infoseciq/learners/by-email/${encodeURIComponent(learner.email)}`)
      .then(d => setHistory(d?.phishing_history || []))
      .catch(e => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [learner.email]);

  if (loading) {
    return <div className="text-xs text-slate-400 py-3 px-4">Loading phishing history…</div>;
  }
  if (error) {
    return <div className="text-xs text-red-500 py-3 px-4">{error}</div>;
  }
  if (!history || history.length === 0) {
    return <div className="text-xs text-slate-400 py-3 px-4">No phishing campaign history found.</div>;
  }

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-slate-500 uppercase tracking-wide text-[10px] border-b border-slate-100">
          <th className="pb-1.5 text-left font-semibold px-4">Campaign</th>
          <th className="pb-1.5 text-left font-semibold">Sent</th>
          <th className="pb-1.5 text-left font-semibold">Opened</th>
          <th className="pb-1.5 text-left font-semibold">Clicked</th>
          <th className="pb-1.5 text-left font-semibold">Reported</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-50">
        {history.map((h, i) => (
          <tr key={i}>
            <td className="py-1.5 px-4 text-slate-700">{h.campaign_name || '—'}</td>
            <td className="py-1.5 text-slate-500">{fmtDate(h.sent_at)}</td>
            <td className="py-1.5 text-slate-500">{h.opened_at ? fmtDate(h.opened_at) : <span className="text-slate-300">—</span>}</td>
            <td className="py-1.5">
              {h.clicked_at
                ? <span className="text-red-600 font-medium">{fmtDate(h.clicked_at)}</span>
                : <span className="text-green-600">—</span>}
            </td>
            <td className="py-1.5">
              {h.reported_at
                ? <span className="text-green-600 font-medium">{fmtDate(h.reported_at)}</span>
                : <span className="text-slate-300">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SORT_OPTIONS = [
  { value: 'risk_score',             label: 'Risk Score' },
  { value: 'training_completion_pct', label: 'Completion %' },
  { value: 'last_name',              label: 'Name' },
  { value: 'phishing_susceptibility', label: 'Phish Susceptibility' },
];

export default function InfosecIqLearners() {
  const [learners, setLearners]   = useState([]);
  const [departments, setDepts]   = useState([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  // Filters / sort / pagination
  const [q, setQ]               = useState('');
  const [dept, setDept]         = useState('');
  const [sort, setSort]         = useState('risk_score');
  const [order, setOrder]       = useState('desc');
  const [page, setPage]         = useState(1);
  const PAGE_SIZE = 50;

  // Debounced search
  const debounceTimer = useRef(null);
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 350);
    return () => clearTimeout(debounceTimer.current);
  }, [q]);

  const fetchLearners = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ sort, order, page, limit: PAGE_SIZE });
    if (debouncedQ) params.set('q', debouncedQ);
    if (dept)       params.set('dept', dept);
    api.get(`/infoseciq/learners?${params}`)
      .then(d => {
        setLearners(d.learners || []);
        setTotal(d.total || 0);
        if (d.departments) setDepts(d.departments);
      })
      .catch(e => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [debouncedQ, dept, sort, order, page]);

  useEffect(() => { fetchLearners(); }, [fetchLearners]);

  const handleSort = (field) => {
    if (sort === field) {
      setOrder(o => o === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(field);
      setOrder('desc');
    }
    setPage(1);
  };

  const handleExportCsv = async () => {
    const params = new URLSearchParams({ sort, order, limit: 9999 });
    if (debouncedQ) params.set('q', debouncedQ);
    if (dept)       params.set('dept', dept);
    const token = localStorage.getItem('cg_token');
    const res = await fetch(`/api/v1/infoseciq/learners?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    const rows = data.learners || [];
    const headers = ['Email', 'First Name', 'Last Name', 'Department', 'Completion %', 'Risk Score', 'Phish Susceptibility %', 'Courses Assigned', 'Courses Completed', 'Last Activity'];
    const csv = [
      headers.join(','),
      ...rows.map(l => [
        l.email,
        l.first_name,
        l.last_name,
        l.department || '',
        l.training_completion_pct ?? '',
        l.risk_score ?? '',
        l.phishing_susceptibility ?? '',
        l.courses_assigned ?? '',
        l.courses_completed ?? '',
        l.last_activity_at ? new Date(l.last_activity_at).toISOString() : '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'infoseciq-learners.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function SortHeader({ field, label }) {
    const active = sort === field;
    return (
      <th
        className="pb-2 text-left font-semibold cursor-pointer select-none hover:text-slate-700"
        onClick={() => handleSort(field)}
      >
        {label}
        {active && <span className="ml-1">{order === 'asc' ? '↑' : '↓'}</span>}
      </th>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Infosec IQ — Learners</h1>
        <button
          onClick={handleExportCsv}
          className="btn-secondary text-sm"
        >
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search name or email…"
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 flex-1 min-w-[200px] max-w-sm"
        />
        <select
          value={dept}
          onChange={e => { setDept(e.target.value); setPage(1); }}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
        >
          <option value="">All departments</option>
          {departments.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select
          value={`${sort}:${order}`}
          onChange={e => {
            const [s, o] = e.target.value.split(':');
            setSort(s);
            setOrder(o);
            setPage(1);
          }}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
        >
          {SORT_OPTIONS.map(o => (
            <option key={`${o.value}:desc`} value={`${o.value}:desc`}>{o.label} (high first)</option>
          ))}
          {SORT_OPTIONS.map(o => (
            <option key={`${o.value}:asc`} value={`${o.value}:asc`}>{o.label} (low first)</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-slate-500 text-xs uppercase tracking-wide">
                <SortHeader field="last_name"              label="Name / Email" />
                <SortHeader field="department"             label="Department" />
                <SortHeader field="training_completion_pct" label="Completion" />
                <SortHeader field="risk_score"             label="Risk Score" />
                <SortHeader field="phishing_susceptibility" label="Phish Susceptibility" />
                <SortHeader field="last_activity_at"       label="Last Activity" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="text-center text-slate-400 py-10 text-sm">Loading…</td>
                </tr>
              )}
              {!loading && learners.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-slate-400 py-10 text-sm">No learners found</td>
                </tr>
              )}
              {!loading && learners.map(l => (
                <>
                  <tr
                    key={l.id}
                    className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer"
                    onClick={() => setExpandedId(expandedId === l.id ? null : l.id)}
                  >
                    <td className="py-2.5 pr-4">
                      <div className="text-xs font-medium text-slate-800">{l.first_name} {l.last_name}</div>
                      <div className="text-xs text-slate-400">{l.email}</div>
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500">{l.department || '—'}</td>
                    <td className="py-2.5 pr-4 min-w-[120px]">
                      <ProgressBar pct={l.training_completion_pct} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${riskColor(l.risk_score ?? 0)}`}>
                        {l.risk_score ?? '—'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-600">
                      {l.phishing_susceptibility != null ? `${l.phishing_susceptibility}%` : '—'}
                    </td>
                    <td className="py-2.5 text-xs text-slate-400">
                      {fmtDateTime(l.last_activity_at)}
                    </td>
                  </tr>
                  {expandedId === l.id && (
                    <tr key={`${l.id}-detail`} className="bg-slate-50 border-b border-slate-100">
                      <td colSpan={6} className="py-3">
                        <div className="px-4 pb-1">
                          <div className="text-xs font-semibold text-slate-600 mb-2">
                            Phishing Campaign History — {l.first_name} {l.last_name}
                          </div>
                          <PhishingHistoryRow learner={l} />
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between mt-4 text-xs text-slate-500">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1 rounded border border-slate-300 disabled:opacity-40 hover:bg-slate-50"
            >
              ← Prev
            </button>
            <span className="px-2 py-1">Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1 rounded border border-slate-300 disabled:opacity-40 hover:bg-slate-50"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
