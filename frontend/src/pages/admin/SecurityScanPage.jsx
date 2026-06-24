import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const SEVERITY_COLOR = {
  critical: 'bg-red-100 text-red-700',
  high:     'bg-red-100 text-red-700',
  moderate: 'bg-amber-100 text-amber-700',
  low:      'bg-slate-100 text-slate-600',
};

function SeverityBadge({ severity }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${SEVERITY_COLOR[severity] || 'bg-slate-100 text-slate-600'}`}>
      {severity}
    </span>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div className="card p-4">
      <div className={`text-2xl font-bold ${accent || 'text-slate-800'}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

export default function SecurityScanPage() {
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['security-scan-latest'],
    queryFn:  () => api.get('/security/scan/latest'),
  });

  const runScan = useMutation({
    mutationFn: () => api.post('/security/scan/run', {}),
    onSuccess:  () => { setError(''); qc.invalidateQueries({ queryKey: ['security-scan-latest'] }); },
    onError:    (err) => setError(err.message),
  });

  const scan     = data?.scan;
  const findings = data?.findings || [];
  const summary  = scan?.summary || {};

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Security Scan</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Backend npm dependency vulnerabilities, cross-referenced against CISA's Known Exploited Vulnerabilities
            (KEV) catalog. Runs automatically every night — KEV is almost entirely enterprise/network-appliance CVEs,
            not application libraries, so a match here is rare; that's expected, not a sign the scan isn't working.
            Frontend dependencies are covered separately by GitHub Dependabot on the repo.
          </p>
        </div>
        <button
          className="btn-secondary text-sm flex-shrink-0"
          onClick={() => runScan.mutate()}
          disabled={runScan.isPending}
        >
          {runScan.isPending ? 'Scanning…' : 'Run Scan Now'}
        </button>
      </div>

      {error && <div className="card p-4 text-red-600 text-sm mb-4">Error: {error}</div>}

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : !scan ? (
        <div className="card p-8 text-center text-slate-400 text-sm">
          No scan has run yet — click "Run Scan Now" or wait for tonight's scheduled scan (5:30am).
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
            <StatCard label="Total Findings" value={summary.total ?? 0} />
            <StatCard label="High" value={summary.bySeverity?.high ?? 0} accent="text-red-700" />
            <StatCard label="Moderate" value={summary.bySeverity?.moderate ?? 0} accent="text-amber-700" />
            <StatCard label="Low" value={summary.bySeverity?.low ?? 0} accent="text-slate-700" />
            <StatCard label="CISA KEV Matches" value={summary.kevCount ?? 0} accent={summary.kevCount > 0 ? 'text-red-700' : 'text-green-700'} />
          </div>

          <p className="text-xs text-slate-400 mb-4">
            Last scanned {new Date(scan.started_at).toLocaleString()}
            {scan.status === 'failed' && <span className="text-red-600 ml-2">— scan failed: {scan.error}</span>}
          </p>

          <div className="card overflow-hidden">
            {findings.length === 0 ? (
              <div className="p-12 text-center text-slate-400">
                <div className="font-medium">No known vulnerabilities found</div>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Package</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Severity</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Issue</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">CVE / GHSA</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Fix</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {findings.map(f => (
                    <tr key={f.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">{f.package_name}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <SeverityBadge severity={f.severity} />
                          {f.is_kev && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-red-600 text-white" title={`CISA KEV — required action by ${f.kev_due_date}`}>
                              KEV
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600 max-w-md">
                        <a href={f.url} target="_blank" rel="noreferrer" className="hover:underline hover:text-primary-600">
                          {f.title}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400 font-mono whitespace-nowrap">
                        {f.cve_id || f.ghsa_id || '—'}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {f.fix_available_version ? (
                          <span className="text-green-600 font-medium">→ {f.fix_available_version}</span>
                        ) : (
                          <span className="text-slate-400">no fix yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
