import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const qc = useQueryClient();
  const [selectedType, setSelectedType] = useState(null);
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState(null);

  const { data: types = [] } = useQuery({ queryKey: ['report-types'], queryFn: () => api.get('/reports/types') });
  const { data: history = [] } = useQuery({ queryKey: ['report-history'], queryFn: () => api.get('/reports/history') });

  const generate = useMutation({
    mutationFn: async () => {
      const token = localStorage.getItem('cg_token');
      const body = { type: selectedType.key };
      if (selectedType.params.includes('from'))       body.from       = new Date(from).toISOString();
      if (selectedType.params.includes('to'))         body.to         = new Date(to).toISOString();
      if (selectedType.params.includes('session_id')) body.session_id = sessionId.trim();
      const res = await fetch('/api/v1/reports/generate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Failed (${res.status})`);
      }
      const blob = await res.blob();
      downloadBlob(blob, `${selectedType.key}.pdf`);
    },
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['report-history'] }); },
    onError: (err) => setError(err.message),
  });

  const downloadPast = async (id, type) => {
    const token = localStorage.getItem('cg_token');
    const res = await fetch(`/api/v1/reports/${id}/download`, { headers: { Authorization: `Bearer ${token}` } });
    const blob = await res.blob();
    downloadBlob(blob, `${type}-${id}.pdf`);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Reports</h1>
      <p className="text-slate-500 text-sm mb-6">
        Generate a point-in-time PDF snapshot for a specific part of the system. Each generated report is saved below and can be re-downloaded later without re-running it against current (since-changed) data.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {types.map(t => (
          <button
            key={t.key}
            onClick={() => { setSelectedType(t); setError(null); }}
            className={`card p-4 text-left transition ${selectedType?.key === t.key ? 'ring-2 ring-primary-500' : 'hover:border-primary-300'}`}
          >
            <div className="font-semibold text-slate-800 text-sm">{t.label}</div>
            <div className="text-xs text-slate-500 mt-1">{t.description}</div>
          </button>
        ))}
      </div>

      {selectedType && (
        <div className="card p-4 mb-6 space-y-3">
          <div className="font-medium text-sm text-slate-700">{selectedType.label}</div>
          {selectedType.params.includes('from') && (
            <div className="flex items-center gap-2">
              <input type="date" className="input text-xs" value={from} onChange={e => setFrom(e.target.value)} />
              <span className="text-slate-400 text-xs">to</span>
              <input type="date" className="input text-xs" value={to} onChange={e => setTo(e.target.value)} />
            </div>
          )}
          {selectedType.params.includes('session_id') && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Session ID</label>
              <input
                type="text"
                className="input text-xs font-mono w-full"
                placeholder="Paste session UUID from TeachSession URL"
                value={sessionId}
                onChange={e => setSessionId(e.target.value)}
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Find the session ID in the URL: /classpulse/sessions/<strong>&lt;id&gt;</strong>/teach
              </p>
            </div>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button className="btn-primary text-sm" disabled={generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? 'Generating…' : 'Generate & Download PDF'}
          </button>
        </div>
      )}

      <h2 className="text-sm font-semibold text-slate-700 mb-3">Recent Reports</h2>
      <div className="card overflow-hidden">
        {!history.length ? (
          <div className="p-8 text-center text-slate-400 text-sm">No reports generated yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Type</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Generated</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">By</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {history.map(h => (
                <tr key={h.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-700">{types.find(t => t.key === h.report_type)?.label || h.report_type}</td>
                  <td className="px-4 py-2 text-slate-500 text-xs">{new Date(h.generated_at).toLocaleString()}</td>
                  <td className="px-4 py-2 text-slate-500 text-xs">{h.generated_by_name || '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <button className="text-xs text-primary-600 hover:underline" onClick={() => downloadPast(h.id, h.report_type)}>
                      Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
