import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const STATUS_BADGE = {
  pending:  'badge-yellow',
  open:     'badge-red',
  resolved: 'badge-slate',
};

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ActiveHoursSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['filter-bypass-hours'], queryFn: () => api.get('/settings/filter-bypass-hours') });
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [days, setDays] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (data) {
      setStart(data.start);
      setEnd(data.end);
      setDays(data.days.split(',').map(Number));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.put('/settings/filter-bypass-hours', { start, end, days: days.join(',') }),
    onSuccess: () => { setOpen(false); qc.invalidateQueries({ queryKey: ['filter-bypass-hours'] }); },
  });

  const toggleDay = (d) => setDays(ds => ds.includes(d) ? ds.filter(x => x !== d) : [...ds, d].sort());

  if (!open) {
    return (
      <button className="text-xs text-slate-400 hover:text-slate-600 mb-4" onClick={() => setOpen(true)}>
        Active hours: {data?.start || '…'}–{data?.end || ''} on {(data?.days || '').split(',').map(d => DAY_LABELS[d]).join('/')} (edit)
      </button>
    );
  }

  return (
    <div className="card p-4 mb-4 space-y-3">
      <div className="text-xs font-semibold text-slate-500 uppercase">Active Hours</div>
      <p className="text-xs text-slate-500">Detection only runs during this window — outside it, a quiet device is normal, not a bypass.</p>
      <div className="flex items-center gap-2">
        <input type="time" className="input text-xs" value={start} onChange={e => setStart(e.target.value)} />
        <span className="text-slate-400 text-xs">to</span>
        <input type="time" className="input text-xs" value={end} onChange={e => setEnd(e.target.value)} />
      </div>
      <div className="flex gap-1">
        {DAY_LABELS.map((label, d) => (
          <button
            key={d}
            onClick={() => toggleDay(d)}
            className={`text-xs px-2 py-1 rounded ${days.includes(d) ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-500'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="btn-primary text-sm" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
        <button className="text-xs text-slate-400" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export default function FilterBypassPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');

  const { data: alerts = [], isLoading } = useQuery({
    queryKey: ['filter-bypass', status],
    queryFn: () => api.get(`/filter-bypass${status ? `?status=${status}` : ''}`),
  });

  const resolve = useMutation({
    mutationFn: (id) => api.post(`/filter-bypass/${id}/resolve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['filter-bypass'] }),
  });

  const runNow = useMutation({
    mutationFn: () => api.post('/filter-bypass/run', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['filter-bypass'] }),
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-slate-900">Filter Bypass Alerts</h1>
        <button className="btn-secondary text-sm" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
          {runNow.isPending ? 'Checking…' : 'Check Now'}
        </button>
      </div>
      <p className="text-slate-500 text-sm mb-6">
        Flags a Chromebook that's connected to school WiFi (confirmed independently of the Chrome extension, via the
        network controller) but generating zero web traffic through ClassGuard's own filter — the signature of a
        student having switched DNS servers, tunneled, or otherwise routed around the filter entirely. <strong>Pending</strong> means
        it was just detected and is waiting on a second check (~15 min) before alerting, to rule out a device that
        simply just connected. Only checks Chromebooks 1:1-assigned to a real student account — shared/kiosk/cart
        devices (anything where the same person is "assigned" more than one device) are automatically excluded, since
        those never generate normal browsing traffic to begin with. Devices that are off school WiFi entirely aren't
        checked either — there's no way to observe a bypass on a network we never see traffic from.
      </p>

      <ActiveHoursSettings />

      <div className="flex gap-2 mb-4">
        {['', 'pending', 'open', 'resolved'].map(s => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`text-xs px-3 py-1 rounded-full border ${status === s ? 'bg-primary-600 text-white border-primary-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-slate-400 text-sm">Loading…</div>
        ) : !alerts.length ? (
          <div className="p-8 text-center text-slate-400 text-sm">No alerts.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Student</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Status</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Last IP / AP</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">First Detected</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Last Checked</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {alerts.map(a => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-700">{a.student_name || a.student_email || '—'}</td>
                  <td className="px-4 py-2"><span className={`${STATUS_BADGE[a.status]} text-xs`}>{a.status}</span></td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    <div className="font-mono">{a.last_ip}</div>
                    <div>{a.detail?.apName || '—'} {a.detail?.ssid ? `(${a.detail.ssid})` : ''}</div>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{new Date(a.first_detected_at).toLocaleString()}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{new Date(a.last_checked_at).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">
                    {a.status !== 'resolved' && (
                      <button className="text-xs text-primary-600 hover:underline" onClick={() => resolve.mutate(a.id)}>
                        Resolve
                      </button>
                    )}
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
