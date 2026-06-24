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

// District-wide choice of how a student resolves to a schedule -- OU prefix
// match or exact grade-level match, never both at once, so there's exactly
// one unambiguous matching rule in effect everywhere.
function MatchModeBar() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['bell-schedule-match-mode'],
    queryFn:  () => api.get('/bell-schedule/match-mode'),
  });
  const setMode = useMutation({
    mutationFn: mode => api.put('/bell-schedule/match-mode', { mode }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['bell-schedule-match-mode'] }),
  });
  const mode = data?.mode || 'grade_level';

  return (
    <div className="card p-4 mb-6 flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-semibold text-slate-800">Match students to a schedule by</div>
        <div className="text-xs text-slate-500 mt-0.5">
          Pick one — assignment rules of the other kind still exist but won't be applied until you switch back.
        </div>
      </div>
      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
        {[['grade_level', 'Grade Level'], ['ou', 'Google OU']].map(([value, label]) => (
          <button
            key={value}
            onClick={() => setMode.mutate(value)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              mode === value ? 'bg-primary-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AddAssignmentForm({ scheduleId, matchMode, onClose }) {
  const qc = useQueryClient();
  const [ou, setOu] = useState('');
  const [grade, setGrade] = useState('');

  const { data: ouList = [] } = useQuery({
    queryKey: ['bell-schedule-ou-list'],
    queryFn:  () => api.get('/bell-schedule/ou-list'),
    enabled:  matchMode === 'ou',
  });
  const { data: gradeLevels = [] } = useQuery({
    queryKey: ['bell-schedule-grade-levels'],
    queryFn:  () => api.get('/bell-schedule/grade-levels'),
    enabled:  matchMode === 'grade_level',
  });

  const create = useMutation({
    mutationFn: () => api.post('/bell-schedule/assignments', matchMode === 'ou'
      ? { schedule_id: scheduleId, target_type: 'ou', target_ou: ou }
      : { schedule_id: scheduleId, target_type: 'grade_level', target_grade_level: grade }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['bell-schedule-assignments'] });
      qc.invalidateQueries({ queryKey: ['bell-schedules'] });
      onClose();
    },
  });

  return (
    <div className="border border-primary-200 bg-primary-50/40 rounded-lg p-3 space-y-2">
      {matchMode === 'ou' ? (
        <div>
          <input
            className="input text-sm" placeholder="/Students/Middle School/Team B" value={ou}
            list="bell-schedule-ou-datalist" onChange={e => setOu(e.target.value)}
          />
          <datalist id="bell-schedule-ou-datalist">
            {ouList.map(p => <option key={p} value={p} />)}
          </datalist>
        </div>
      ) : (
        <div>
          <input
            className="input text-sm" placeholder="e.g. 7" value={grade}
            list="bell-schedule-grade-datalist" onChange={e => setGrade(e.target.value)}
          />
          <datalist id="bell-schedule-grade-datalist">
            {gradeLevels.map(g => <option key={g} value={g} />)}
          </datalist>
        </div>
      )}
      {create.isError && <p className="text-xs text-red-600">{create.error.message}</p>}
      <div className="flex gap-2">
        <button className="btn-secondary text-xs" onClick={onClose}>Cancel</button>
        <button
          className="btn-primary text-xs"
          disabled={(matchMode === 'ou' ? !ou.trim() : !grade.trim()) || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Adding…' : 'Add assignment'}
        </button>
      </div>
    </div>
  );
}

function AssignmentsSection({ scheduleId, matchMode }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const { data: allAssignments = [] } = useQuery({
    queryKey: ['bell-schedule-assignments'],
    queryFn:  () => api.get('/bell-schedule/assignments'),
  });
  const remove = useMutation({
    mutationFn: id => api.delete(`/bell-schedule/assignments/${id}`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['bell-schedule-assignments'] });
      qc.invalidateQueries({ queryKey: ['bell-schedules'] });
    },
  });

  const assignments = allAssignments.filter(a => a.schedule_id === scheduleId && a.target_type === matchMode);
  const label = a => a.target_type === 'ou' ? a.target_ou : `Grade ${a.target_grade_level}`;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-800">
          Assigned {matchMode === 'ou' ? 'OUs' : 'grade levels'}
        </h3>
        {!adding && <button className="text-xs text-primary-600 hover:underline" onClick={() => setAdding(true)}>+ Add</button>}
      </div>
      <div className="space-y-1.5 mb-2">
        {assignments.map(a => (
          <div key={a.id} className="flex items-center justify-between text-sm bg-slate-50 rounded-lg px-3 py-1.5">
            <span className="font-mono text-xs text-slate-700">{label(a)}</span>
            <button className="text-xs text-red-500 hover:underline" onClick={() => remove.mutate(a.id)}>Remove</button>
          </div>
        ))}
        {!assignments.length && !adding && (
          <p className="text-xs text-slate-400">No assignments yet — only students with no matching rule (or every student, if this is the default schedule) follow this schedule.</p>
        )}
      </div>
      {adding && <AddAssignmentForm scheduleId={scheduleId} matchMode={matchMode} onClose={() => setAdding(false)} />}
    </div>
  );
}

function NewPeriodForm({ scheduleId, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ period_label: '', name: '', start_time: '08:00', end_time: '08:50', days_of_week: [1, 2, 3, 4, 5] });

  const create = useMutation({
    mutationFn: () => api.post('/bell-schedule/periods', { schedule_id: scheduleId, ...form }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['bell-schedule-periods', scheduleId] });
      qc.invalidateQueries({ queryKey: ['bell-schedules'] });
      onClose();
    },
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

function PeriodsSection({ scheduleId }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const { data: periods = [], isLoading } = useQuery({
    queryKey: ['bell-schedule-periods', scheduleId],
    queryFn:  () => api.get(`/bell-schedule/periods?schedule_id=${scheduleId}`),
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }) => api.patch(`/bell-schedule/periods/${id}`, body),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['bell-schedule-periods', scheduleId] }),
  });
  const remove = useMutation({
    mutationFn: id => api.delete(`/bell-schedule/periods/${id}`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['bell-schedule-periods', scheduleId] });
      qc.invalidateQueries({ queryKey: ['bell-schedules'] });
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-800">Periods</h3>
        {!adding && <button className="btn-primary text-xs whitespace-nowrap" onClick={() => setAdding(true)}>+ Add period</button>}
      </div>

      {adding && <NewPeriodForm scheduleId={scheduleId} onClose={() => setAdding(false)} />}

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : periods.length === 0 ? (
        <div className="card p-8 text-center text-slate-400">
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

function NewScheduleForm({ onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', description: '' });
  const create = useMutation({
    mutationFn: () => api.post('/bell-schedule/schedules', form),
    onSuccess:  data => { qc.invalidateQueries({ queryKey: ['bell-schedules'] }); onClose(data.id); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
        <h2 className="font-semibold text-slate-900 mb-4">New Bell Schedule</h2>
        <div className="space-y-3 mb-5">
          <div>
            <label className="label">Name</label>
            <input className="input" placeholder="Middle School B" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" placeholder="Optional" value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
        </div>
        {create.isError && <p className="text-sm text-red-600 mb-3">{create.error.message}</p>}
        <div className="flex gap-3 justify-end">
          <button className="btn-secondary" onClick={() => onClose()}>Cancel</button>
          <button className="btn-primary" disabled={!form.name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BellSchedulePage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['bell-schedules'],
    queryFn:  () => api.get('/bell-schedule/schedules'),
  });
  const { data: matchModeData } = useQuery({
    queryKey: ['bell-schedule-match-mode'],
    queryFn:  () => api.get('/bell-schedule/match-mode'),
  });
  const matchMode = matchModeData?.mode || 'grade_level';

  const setDefault = useMutation({
    mutationFn: id => api.put(`/bell-schedule/schedules/${id}/default`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['bell-schedules'] }),
  });
  const deleteSchedule = useMutation({
    mutationFn: id => api.delete(`/bell-schedule/schedules/${id}`),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['bell-schedules'] }); setSelected(null); },
  });

  const schedule = schedules.find(s => s.id === selected);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Bell Schedule</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Create one schedule per group of students that runs on different period times (e.g. a Middle
            School split across two hallway-capacity schedules), and assign each schedule to the students
            who follow it. Anyone with no matching assignment follows the default schedule.
          </p>
        </div>
        <button className="btn-primary whitespace-nowrap" onClick={() => setCreating(true)}>+ New Schedule</button>
      </div>

      <MatchModeBar />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-2">
          {isLoading && <div className="text-slate-400 text-sm">Loading…</div>}
          {schedules.map(s => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={`w-full text-left p-4 rounded-xl border text-sm transition-colors
                ${selected === s.id
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'card border-transparent hover:border-slate-200'}`}
            >
              <div className="font-medium flex items-center gap-2">
                {s.name}
                {s.is_default && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${selected === s.id ? 'bg-white/20' : 'bg-emerald-100 text-emerald-700'}`}>
                    default
                  </span>
                )}
              </div>
              {s.description && (
                <div className={`text-xs mt-0.5 truncate ${selected === s.id ? 'text-primary-200' : 'text-slate-400'}`}>
                  {s.description}
                </div>
              )}
              <div className={`text-xs mt-1 ${selected === s.id ? 'text-primary-200' : 'text-slate-400'}`}>
                {s.period_count} period{s.period_count === '1' ? '' : 's'} · {s.assignment_count} assignment{s.assignment_count === '1' ? '' : 's'}
              </div>
            </button>
          ))}
        </div>

        <div className="lg:col-span-2 space-y-4">
          {!selected && (
            <div className="card p-10 text-center text-slate-400 text-sm">
              Select a schedule to view or edit its periods and assignments
            </div>
          )}

          {schedule && (
            <>
              <div className="card p-4 flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-slate-900">{schedule.name}</h2>
                  {schedule.description && <div className="text-xs text-slate-400 mt-0.5">{schedule.description}</div>}
                </div>
                <div className="flex items-center gap-3">
                  {!schedule.is_default && (
                    <button className="text-xs text-primary-600 hover:underline" onClick={() => setDefault.mutate(schedule.id)}>
                      Set as default
                    </button>
                  )}
                  {!schedule.is_default && (
                    <button
                      className="text-xs text-red-500 hover:underline"
                      onClick={() => { if (confirm('Delete this schedule and its periods/assignments? Affected students fall back to the default schedule.')) deleteSchedule.mutate(schedule.id); }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {schedule.is_default ? (
                <div className="text-xs text-slate-400 px-1">
                  This is the default schedule — it applies to any student with no matching assignment below.
                </div>
              ) : (
                <AssignmentsSection scheduleId={schedule.id} matchMode={matchMode} />
              )}

              <PeriodsSection scheduleId={schedule.id} />
            </>
          )}
        </div>
      </div>

      {creating && <NewScheduleForm onClose={(id) => { setCreating(false); if (id) setSelected(id); }} />}
    </div>
  );
}
