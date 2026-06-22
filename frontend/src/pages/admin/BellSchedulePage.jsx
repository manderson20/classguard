import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function DayPicker({ value, onChange }) {
  return (
    <div className="flex gap-1">
      {DAY_LABELS.map((label, i) => {
        const active = value.includes(i);
        return (
          <button
            key={i}
            type="button"
            onClick={() => onChange(active ? value.filter(d => d !== i) : [...value, i].sort())}
            className={`w-9 h-7 rounded text-xs font-medium ${active ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-400'}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function NewPeriodForm({ onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ period_label: '', name: '', start_time: '08:00', end_time: '08:50', days_of_week: [1, 2, 3, 4, 5] });

  const create = useMutation({
    mutationFn: () => api.post('/bell-schedule', form),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['bell-schedule'] }); onClose(); },
  });

  return (
    <div className="card p-4 mb-4 border-2 border-primary-200">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <div>
          <label className="label">Period label</label>
          <input className="input" placeholder='e.g. "3" or "Period 3"' value={form.period_label}
            onChange={e => setForm(f => ({ ...f, period_label: e.target.value }))} />
          <p className="text-xs text-slate-400 mt-1">Must match the period value from your roster sync exactly.</p>
        </div>
        <div>
          <label className="label">Display name (optional)</label>
          <input className="input" placeholder="3rd Period" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </div>
        <div>
          <label className="label">Start time</label>
          <input type="time" className="input" value={form.start_time}
            onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))} />
        </div>
        <div>
          <label className="label">End time</label>
          <input type="time" className="input" value={form.end_time}
            onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} />
        </div>
      </div>
      <div className="mb-3">
        <label className="label">Days</label>
        <DayPicker value={form.days_of_week} onChange={d => setForm(f => ({ ...f, days_of_week: d }))} />
      </div>
      {create.isError && <p className="text-sm text-red-600 mb-2">{create.error.message}</p>}
      <div className="flex gap-2">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!form.period_label || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Adding…' : 'Add period'}
        </button>
      </div>
    </div>
  );
}

export default function BellSchedulePage() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const { data: periods = [], isLoading } = useQuery({
    queryKey: ['bell-schedule'],
    queryFn:  () => api.get('/bell-schedule'),
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }) => api.patch(`/bell-schedule/${id}`, body),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['bell-schedule'] }),
  });
  const remove = useMutation({
    mutationFn: (id) => api.delete(`/bell-schedule/${id}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['bell-schedule'] }),
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Bell Schedule</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Maps each period label from your roster sync to an actual time of day — your SIS feed only
            provides a period label (e.g. "3"), never clock times, so this has to be configured here.
            Used by Staff Analytics to measure device activity during a teacher's scheduled periods.
          </p>
        </div>
        {!adding && <button className="btn-primary whitespace-nowrap" onClick={() => setAdding(true)}>+ Add period</button>}
      </div>

      {adding && <NewPeriodForm onClose={() => setAdding(false)} />}

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : periods.length === 0 ? (
        <div className="card p-10 text-center text-slate-400">
          <div className="text-3xl mb-2">🔔</div>
          <div className="text-sm">No periods configured yet.</div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Period label</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Start</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">End</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Days</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {periods.map(p => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono font-medium text-slate-800">{p.period_label}</td>
                  <td className="px-4 py-3 text-slate-600">{p.name || <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-3">
                    <input type="time" className="input text-xs w-28" defaultValue={p.start_time}
                      onBlur={e => update.mutate({ id: p.id, start_time: e.target.value })} />
                  </td>
                  <td className="px-4 py-3">
                    <input type="time" className="input text-xs w-28" defaultValue={p.end_time}
                      onBlur={e => update.mutate({ id: p.id, end_time: e.target.value })} />
                  </td>
                  <td className="px-4 py-3">
                    <DayPicker value={p.days_of_week} onChange={d => update.mutate({ id: p.id, days_of_week: d })} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button className="text-xs text-red-500 hover:underline" onClick={() => remove.mutate(p.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
