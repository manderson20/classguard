import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import api from '../../lib/api';

// Post-session results view — the stored answers from a ClassPulse session,
// readable after the fact. Reached from the session-ended screen, the Hub's
// recent-sessions list, or a bookmarked URL.

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function McResults({ question, studentsById }) {
  const total = question.responses.length;
  const counts = {};
  for (const r of question.responses) {
    for (const oid of (r.option_ids || [])) counts[oid] = (counts[oid] || 0) + 1;
  }
  const max = Math.max(...question.options.map(o => counts[o.id] || 0), 1);

  return (
    <div className="space-y-4">
      {/* Tally bars */}
      <div className="space-y-2">
        {question.options.map(o => (
          <div key={o.id}>
            <div className="flex items-center justify-between mb-0.5">
              <span className={`text-sm font-medium ${o.is_correct ? 'text-emerald-700' : 'text-slate-600'}`}>
                {o.is_correct && <span className="mr-1">✓</span>}{o.text}
              </span>
              <span className="text-xs text-slate-400">{counts[o.id] || 0}</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${o.is_correct ? 'bg-emerald-400' : 'bg-indigo-400'}`}
                style={{ width: `${((counts[o.id] || 0) / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Per-student answers */}
      <details className="group">
        <summary className="text-xs font-medium text-indigo-600 cursor-pointer select-none">
          Show each student's answer ({total})
        </summary>
        <div className="mt-2 divide-y divide-slate-100 border border-slate-100 rounded-lg">
          {question.responses.map((r, i) => {
            const picked = question.options.filter(o => (r.option_ids || []).includes(o.id));
            const correct = picked.length > 0 && picked.every(o => o.is_correct);
            return (
              <div key={i} className="flex items-center justify-between px-3 py-1.5 text-sm">
                <span className="text-slate-700">{studentsById[r.student_id]?.full_name || 'Unknown student'}</span>
                <span className={correct ? 'text-emerald-600 font-medium' : 'text-slate-500'}>
                  {picked.map(o => o.text).join(', ') || '—'} {correct ? '✓' : '✗'}
                </span>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function TextResults({ question, studentsById }) {
  return (
    <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
      {question.responses.map((r, i) => (
        <div key={i} className={`px-3 py-2 ${r.is_flagged ? 'bg-amber-50' : ''}`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">
              {studentsById[r.student_id]?.full_name || 'Unknown student'}
            </span>
            {r.is_flagged && <span className="text-[10px] font-semibold text-amber-600">⚑ Flagged</span>}
          </div>
          <p className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{r.text_value || '—'}</p>
        </div>
      ))}
    </div>
  );
}

export default function SessionResults() {
  const { id: sessionId } = useParams();

  const { data: report, isLoading, error } = useQuery({
    queryKey: ['classpulse-report', sessionId],
    queryFn:  () => api.get(`/classpulse/sessions/${sessionId}/report`),
  });

  if (isLoading) {
    return <div className="p-10 text-center text-slate-400 text-sm">Loading results…</div>;
  }
  if (error || !report) {
    return (
      <div className="p-10 text-center">
        <p className="text-rose-600 text-sm mb-3">{error?.message || 'Results not found'}</p>
        <Link to="/classpulse" className="btn btn-secondary text-sm">Back to ClassPulse</Link>
      </div>
    );
  }

  const { session, participation, students, questions } = report;
  const studentsById = Object.fromEntries(students.map(s => [s.student_id, s]));

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <Link to="/classpulse" className="text-xs text-indigo-600 hover:text-indigo-800">← ClassPulse</Link>
        <div className="flex items-start justify-between gap-4 mt-1 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">{session.lesson_title || 'Session results'}</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {session.class_name ? `${session.class_name} · ` : ''}
              {fmtDate(session.started_at)} · {session.duration_minutes} min
              {session.status === 'active' && <span className="ml-2 text-emerald-600 font-medium">● Still live</span>}
            </p>
          </div>
          {session.status === 'active' && (
            <Link to={`/classpulse/sessions/${session.id}/teach`} className="btn btn-primary text-sm">
              Rejoin live session
            </Link>
          )}
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Students joined', value: participation.total_joined },
          { label: 'Responded',       value: participation.responded },
          { label: 'Participation',   value: `${participation.participation_pct}%` },
        ].map(t => (
          <div key={t.label} className="bg-white border border-slate-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-slate-800">{t.value}</p>
            <p className="text-xs text-slate-400 mt-0.5">{t.label}</p>
          </div>
        ))}
      </div>

      {/* Questions */}
      {questions.length === 0 && (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-8 text-center text-sm text-slate-400">
          No responses were recorded in this session.
        </div>
      )}
      {questions.map(q => (
        <div key={q.question_id} className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div>
            <span className="text-[10px] font-semibold text-indigo-500 uppercase tracking-wide">
              {q.page_title || `Slide ${q.page_position}`} ·{' '}
              {q.question_type === 'multiple_choice' ? 'Multiple Choice' :
               q.question_type === 'true_false'      ? 'True / False'    :
               q.question_type === 'exit_ticket'     ? 'Exit Ticket'     : 'Short Answer'}
            </span>
            <p className="text-base font-semibold text-slate-800 mt-0.5">{q.prompt}</p>
          </div>
          {['multiple_choice', 'true_false'].includes(q.question_type)
            ? <McResults question={q} studentsById={studentsById} />
            : <TextResults question={q} studentsById={studentsById} />}
        </div>
      ))}
    </div>
  );
}
