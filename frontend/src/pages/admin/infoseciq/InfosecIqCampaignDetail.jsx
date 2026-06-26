import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../../../lib/api';

function StatusBadge({ status }) {
  const isActive = status === 'active' || status === 'running';
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      isActive ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'
    }`}>
      {status || '—'}
    </span>
  );
}

function clickRateColor(rate) {
  if (rate > 25) return 'text-red-600';
  if (rate > 10) return 'text-yellow-600';
  return 'text-green-600';
}

function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString();
}

function fmtDateTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString();
}

function DateCell({ iso }) {
  if (!iso) return <span className="text-slate-300">—</span>;
  return <span className="text-slate-600">{fmtDateTime(iso)}</span>;
}

function ResultsTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <p className="text-sm text-slate-400 py-6 text-center">No recipients in this view</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-slate-500 text-xs uppercase tracking-wide">
            <th className="pb-2 text-left font-semibold">Name</th>
            <th className="pb-2 text-left font-semibold">Email</th>
            <th className="pb-2 text-left font-semibold">Department</th>
            <th className="pb-2 text-left font-semibold">Sent</th>
            <th className="pb-2 text-left font-semibold">Opened</th>
            <th className="pb-2 text-left font-semibold">Clicked</th>
            <th className="pb-2 text-left font-semibold">Reported</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-slate-50">
              <td className="py-2 pr-4 text-xs font-medium text-slate-800">
                {r.first_name} {r.last_name}
              </td>
              <td className="py-2 pr-4 text-xs text-slate-500">{r.email}</td>
              <td className="py-2 pr-4 text-xs text-slate-500">{r.department || '—'}</td>
              <td className="py-2 pr-4 text-xs"><DateCell iso={r.sent_at} /></td>
              <td className="py-2 pr-4 text-xs"><DateCell iso={r.opened_at} /></td>
              <td className="py-2 pr-4 text-xs">
                {r.clicked_at
                  ? <span className="text-red-600 font-medium">{fmtDateTime(r.clicked_at)}</span>
                  : <span className="text-slate-300">—</span>}
              </td>
              <td className="py-2 text-xs">
                {r.reported_at
                  ? <span className="text-green-600 font-medium">{fmtDateTime(r.reported_at)}</span>
                  : <span className="text-slate-300">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TABS = ['Clicked', 'Reported', 'All Recipients'];

export default function InfosecIqCampaignDetail() {
  const { id } = useParams();
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [tab, setTab]       = useState('All Recipients');

  useEffect(() => {
    api.get(`/infoseciq/campaigns/${id}`)
      .then(setData)
      .catch(e => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [id]);

  const c = data;

  const tabRows = () => {
    if (!data) return [];
    if (tab === 'Clicked')        return data.clickers   || [];
    if (tab === 'Reported')       return data.reporters  || [];
    if (tab === 'All Recipients') return data.results    || [];
    return [];
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Back link */}
      <div className="mb-4">
        <Link to="/admin/infoseciq/campaigns" className="text-xs text-slate-500 hover:text-slate-700">
          ← Back to Campaigns
        </Link>
      </div>

      {loading && (
        <div className="text-slate-400 text-sm text-center py-16">Loading…</div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && c && (
        <>
          {/* Campaign header */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 mb-6">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
              <div>
                <h1 className="text-xl font-bold text-slate-900">{c.name}</h1>
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  <StatusBadge status={c.status} />
                  <span className="text-xs text-slate-400">
                    {fmtDate(c.start_date)}
                    {c.end_date ? ` – ${fmtDate(c.end_date)}` : ''}
                  </span>
                </div>
              </div>
            </div>

            {/* Summary stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-slate-100">
              <div>
                <div className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-1">Recipients</div>
                <div className="text-xl font-bold text-slate-800">{c.recipients_total ?? '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-1">Emails Sent</div>
                <div className="text-xl font-bold text-slate-800">{c.emails_sent ?? '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-1">Click Rate</div>
                <div className={`text-xl font-bold ${clickRateColor(c.click_rate ?? 0)}`}>
                  {c.click_rate != null ? `${Number(c.click_rate).toFixed(1)}%` : '—'}
                </div>
                <div className="text-xs text-slate-400">{c.clicks ?? 0} clicks</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-1">Report Rate</div>
                <div className="text-xl font-bold text-green-600">
                  {c.report_rate != null ? `${Number(c.report_rate).toFixed(1)}%` : '—'}
                </div>
                <div className="text-xs text-slate-400">{c.reports ?? 0} reports</div>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="flex gap-1 border-b border-slate-100 px-4 pt-2">
              {TABS.map(t => {
                const count = t === 'Clicked'
                  ? (data.clickers  || []).length
                  : t === 'Reported'
                    ? (data.reporters || []).length
                    : (data.results   || []).length;
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-4 py-2 text-xs font-medium rounded-t transition-colors whitespace-nowrap
                      ${tab === t
                        ? 'bg-white border border-b-white border-slate-200 text-primary-700 -mb-px'
                        : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    {t}
                    <span className="ml-1.5 text-[10px] text-slate-400">({count})</span>
                  </button>
                );
              })}
            </div>
            <div className="p-5">
              <ResultsTable rows={tabRows()} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
