import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../../lib/api';

function riskColor(score) {
  if (score > 60) return 'bg-red-100 text-red-700';
  if (score > 30) return 'bg-yellow-100 text-yellow-700';
  return 'bg-green-100 text-green-700';
}

function clickRateColor(rate) {
  if (rate > 25) return 'bg-red-100 text-red-700';
  if (rate > 10) return 'bg-yellow-100 text-yellow-700';
  return 'bg-green-100 text-green-700';
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function fmtShortDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

function StatCard({ title, value, sub, valueClass }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex flex-col gap-1">
      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{title}</div>
      <div className={`text-2xl font-bold text-slate-900 ${valueClass || ''}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
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

export default function InfosecIqDashboard() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.get('/infoseciq/summary')
      .then(setData)
      .catch(e => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      await api.post('/infoseciq/sync');
      setSyncMsg('Sync started');
      setTimeout(() => setSyncMsg(null), 4000);
    } catch (e) {
      setSyncMsg('Sync failed: ' + (e.message || 'Unknown error'));
    } finally {
      setSyncing(false);
    }
  };

  const learners  = data?.learners  || {};
  const recent    = data?.recentCampaigns || [];
  const highRisk  = data?.highRisk  || [];
  const isEmpty   = !loading && !error && (learners.total_learners || 0) === 0;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Infosec IQ</h1>
          {data?.lastSync && (
            <p className="text-xs text-slate-400 mt-0.5">Last synced: {fmtDate(data.lastSync)}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {syncMsg && (
            <span className={`text-xs font-medium ${syncMsg.startsWith('Sync failed') ? 'text-red-600' : 'text-green-600'}`}>
              {syncMsg}
            </span>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="btn-primary text-sm disabled:opacity-50"
          >
            {syncing ? 'Starting…' : 'Sync Now'}
          </button>
        </div>
      </div>

      {loading && (
        <div className="text-slate-400 text-sm text-center py-16">Loading…</div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {isEmpty && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-10 text-center">
          <div className="text-4xl mb-3">🛡</div>
          <h2 className="text-lg font-semibold text-slate-700 mb-2">No data yet</h2>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            Configure your Infosec IQ credentials in{' '}
            <Link to="/admin/integrations" className="text-primary-600 hover:underline">
              Integrations
            </Link>
            , then click Sync Now to pull in your learners and campaigns.
          </p>
        </div>
      )}

      {!loading && !error && !isEmpty && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard
              title="Staff Trained"
              value={`${learners.fully_trained ?? 0} / ${learners.total_learners ?? 0}`}
              sub={
                (learners.total_learners || 0) > 0
                  ? `${Math.round(((learners.fully_trained || 0) / learners.total_learners) * 100)}% complete`
                  : '0%'
              }
            />
            <StatCard
              title="Avg Completion"
              value={`${Math.round(learners.avg_completion_pct ?? 0)}%`}
              sub="across all learners"
            />
            <StatCard
              title="Avg Risk Score"
              value={`${Math.round(learners.avg_risk_score ?? 0)}`}
              valueClass={
                (learners.avg_risk_score ?? 0) > 60 ? 'text-red-600' :
                (learners.avg_risk_score ?? 0) > 30 ? 'text-yellow-600' :
                'text-green-600'
              }
              sub="0 = low risk, 100 = high"
            />
            <StatCard
              title="Avg Phish Click Rate"
              value={`${Math.round(learners.avg_susceptibility ?? 0)}%`}
              valueClass={
                (learners.avg_susceptibility ?? 0) > 25 ? 'text-red-600' :
                (learners.avg_susceptibility ?? 0) > 10 ? 'text-yellow-600' :
                'text-green-600'
              }
              sub="phishing simulation"
            />
          </div>

          {/* Recent Campaigns */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-700">Recent Campaigns</h2>
              <Link to="/admin/infoseciq/campaigns" className="text-xs text-primary-600 hover:underline">
                View all →
              </Link>
            </div>
            {recent.length === 0 ? (
              <p className="text-sm text-slate-400 py-4 text-center">No campaigns found</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-slate-500 text-xs uppercase tracking-wide">
                      <th className="pb-2 text-left font-semibold">Name</th>
                      <th className="pb-2 text-left font-semibold">Status</th>
                      <th className="pb-2 text-left font-semibold">Dates</th>
                      <th className="pb-2 text-right font-semibold">Recipients</th>
                      <th className="pb-2 text-right font-semibold">Click Rate</th>
                      <th className="pb-2 text-right font-semibold">Report Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {recent.map(c => (
                      <tr
                        key={c.id}
                        className="hover:bg-slate-50 cursor-pointer"
                        onClick={() => navigate(`/admin/infoseciq/campaigns/${c.id}`)}
                      >
                        <td className="py-2.5 pr-4 font-medium text-slate-800 text-xs">{c.name}</td>
                        <td className="py-2.5 pr-4">
                          <StatusBadge status={c.status} />
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-slate-500">
                          {fmtShortDate(c.start_date)}
                          {c.end_date ? ` – ${fmtShortDate(c.end_date)}` : ''}
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-slate-700 text-right">
                          {c.recipients_total ?? '—'}
                        </td>
                        <td className="py-2.5 pr-4 text-right">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${clickRateColor(c.click_rate ?? 0)}`}>
                            {c.click_rate != null ? `${Number(c.click_rate).toFixed(1)}%` : '—'}
                          </span>
                        </td>
                        <td className="py-2.5 text-xs text-slate-600 text-right">
                          {c.report_rate != null ? `${Number(c.report_rate).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* High Risk Staff */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-700">
                High Risk Staff
                {highRisk.length > 0 && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                    {highRisk.length}
                  </span>
                )}
              </h2>
              <Link to="/admin/infoseciq/learners" className="text-xs text-primary-600 hover:underline">
                View all learners →
              </Link>
            </div>
            {highRisk.length === 0 ? (
              <p className="text-sm text-slate-400 py-2 text-center">
                No learners with risk score above 70
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-slate-500 text-xs uppercase tracking-wide">
                      <th className="pb-2 text-left font-semibold">Name</th>
                      <th className="pb-2 text-left font-semibold">Department</th>
                      <th className="pb-2 text-right font-semibold">Risk Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {highRisk.map(l => (
                      <tr key={l.id} className="hover:bg-slate-50">
                        <td className="py-2 pr-4">
                          <div className="text-xs font-medium text-slate-800">
                            {l.first_name} {l.last_name}
                          </div>
                          <div className="text-xs text-slate-400">{l.email}</div>
                        </td>
                        <td className="py-2 pr-4 text-xs text-slate-500">{l.department || '—'}</td>
                        <td className="py-2 text-right">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${riskColor(l.risk_score)}`}>
                            {l.risk_score}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
