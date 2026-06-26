import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../lib/api';

function clickRateColor(rate) {
  if (rate > 25) return 'bg-red-100 text-red-700';
  if (rate > 10) return 'bg-yellow-100 text-yellow-700';
  return 'bg-green-100 text-green-700';
}

function StatusBadge({ status }) {
  const isActive = status === 'active' || status === 'running';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
      isActive ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'
    }`}>
      {status || '—'}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export default function InfosecIqCampaigns() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  useEffect(() => {
    api.get('/infoseciq/campaigns')
      .then(d => setCampaigns(Array.isArray(d) ? d : (d.campaigns || [])))
      .catch(e => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Infosec IQ — Campaigns</h1>
        <p className="text-sm text-slate-500 mt-0.5">Phishing simulation campaigns and results</p>
      </div>

      {loading && (
        <div className="text-slate-400 text-sm text-center py-16">Loading…</div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500 text-xs uppercase tracking-wide">
                  <th className="px-4 pb-3 pt-4 text-left font-semibold">Campaign Name</th>
                  <th className="pb-3 pt-4 text-left font-semibold">Status</th>
                  <th className="pb-3 pt-4 text-left font-semibold">Start Date</th>
                  <th className="pb-3 pt-4 text-left font-semibold">End Date</th>
                  <th className="pb-3 pt-4 text-right font-semibold">Recipients</th>
                  <th className="pb-3 pt-4 text-right font-semibold">Sent</th>
                  <th className="pb-3 pt-4 text-right font-semibold">Opens</th>
                  <th className="pb-3 pt-4 text-right font-semibold">Click Rate</th>
                  <th className="pb-3 pt-4 text-right font-semibold pr-4">Report Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {campaigns.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-center text-slate-400 py-10 text-sm">
                      No campaigns found
                    </td>
                  </tr>
                )}
                {campaigns.map(c => (
                  <tr
                    key={c.id}
                    className="hover:bg-slate-50 cursor-pointer"
                    onClick={() => navigate(`/admin/infoseciq/campaigns/${c.id}`)}
                  >
                    <td className="px-4 py-2.5 font-medium text-slate-800 text-xs">{c.name}</td>
                    <td className="py-2.5 pr-4">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500">{fmtDate(c.start_date)}</td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500">{fmtDate(c.end_date)}</td>
                    <td className="py-2.5 pr-4 text-xs text-slate-700 text-right">{c.recipients_total ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-xs text-slate-700 text-right">{c.emails_sent ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-xs text-slate-700 text-right">{c.opens ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${clickRateColor(c.click_rate ?? 0)}`}>
                        {c.click_rate != null ? `${Number(c.click_rate).toFixed(1)}%` : '—'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-600 text-right">
                      {c.report_rate != null ? `${Number(c.report_rate).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
