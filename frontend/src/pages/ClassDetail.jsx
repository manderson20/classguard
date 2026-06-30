import { useState, useEffect, Fragment } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';
import StartLessonModal from '../components/StartLessonModal';
import { TraceContent } from '../components/WhyBlockedTrace';

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function formatDuration(startedAt, endedAt) {
  if (!endedAt) return 'Live';
  const ms = new Date(endedAt) - new Date(startedAt);
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Per-lesson activity detail — every student's browsing during just this
// session (lesson_session_id filter from Phase 3), not scoped to one
// student like ActiveLesson.jsx's live History panel. GET /browser-history
// already restricts results to the teacher's own roster server-side, so no
// extra ownership check is needed here.
function LessonActivity({ lesson }) {
  const [whyKey, setWhyKey] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['lesson-activity', lesson.id],
    queryFn:  () => {
      const p = new URLSearchParams({
        lesson_session_id: lesson.id,
        from:               lesson.started_at,
        to:                 lesson.ended_at || new Date().toISOString(),
        limit:              200,
      });
      return api.get(`/extension/browser-history?${p}`);
    },
  });

  const rows = data?.results || [];

  if (isLoading) return <div className="text-sm text-slate-400 px-2 py-3">Loading…</div>;
  if (rows.length === 0) return <div className="text-sm text-slate-400 px-2 py-3">No browsing activity recorded for this session</div>;

  return (
    <div className="px-2 py-3 space-y-1.5 max-h-96 overflow-y-auto">
      {rows.map(r => (
        <div key={r.id} className="text-xs border-b border-slate-100 pb-1.5 last:border-0">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="font-medium text-slate-700">{r.student_name || r.user_id?.slice(0, 8)}</span>
              <span className="text-slate-400"> · </span>
              <span className="text-slate-600 truncate">{r.title || hostnameOf(r.url)}</span>
            </div>
            <span className="text-slate-400 whitespace-nowrap">{new Date(r.visited_at).toLocaleTimeString()}</span>
          </div>
          {r.action === 'blocked' && (
            <button onClick={() => setWhyKey(whyKey === r.id ? null : r.id)} className="text-red-500 hover:underline">
              Blocked: {r.block_reason || 'why?'}
            </button>
          )}
          {whyKey === r.id && (
            <div className="mt-1 bg-slate-50 rounded p-2">
              <TraceContent studentId={r.user_id} domain={hostnameOf(r.url)} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PastLessonsTab({ classId }) {
  const [page, setPage]       = useState(1);
  const [expanded, setExpanded] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['class-lessons', classId, page],
    queryFn:  () => api.get(`/classes/${classId}/lessons?page=${page}&limit=20`),
    keepPreviousData: true,
  });

  const { results: lessons = [], total = 0 } = data || {};
  const totalPages = Math.max(Math.ceil(total / 20), 1);

  return (
    <div>
      <div className="flex items-center justify-between mb-3 text-sm text-slate-600">
        <span>{isLoading ? 'Loading…' : `${total} lesson${total !== 1 ? 's' : ''}`}{total > 0 && ` · page ${page} of ${totalPages}`}</span>
        <div className="flex gap-2">
          <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <button className="btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Lesson</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Started</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Duration</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Allowed domains</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Participants</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Blocked</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lessons.map(lesson => (
              <Fragment key={lesson.id}>
                <tr className="hover:bg-slate-50 cursor-pointer" onClick={() => setExpanded(expanded === lesson.id ? null : lesson.id)}>
                  <td className="px-4 py-2.5">
                    {lesson.name || 'Untitled lesson'}
                    {lesson.is_active && <span className="badge-blue ml-2">Live</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">
                    {new Date(lesson.started_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                    {formatDuration(lesson.started_at, lesson.ended_at)}
                  </td>
                  <td className="px-4 py-2.5 max-w-xs">
                    {(lesson.allowed_domains || []).length > 0 ? (
                      <span className="text-xs text-slate-600 truncate">
                        {lesson.allowed_domains.slice(0, 3).join(', ')}{lesson.allowed_domains.length > 3 ? ` +${lesson.allowed_domains.length - 3}` : ''}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">All blocked</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">{lesson.participant_count}</td>
                  <td className="px-4 py-2.5 text-xs">
                    {parseInt(lesson.blocked_count, 10) > 0 ? (
                      <span className="badge-red">{lesson.blocked_count}</span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                </tr>
                {expanded === lesson.id && (
                  <tr className="bg-slate-50">
                    <td colSpan={6}><LessonActivity lesson={lesson} /></td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!isLoading && lessons.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-400 text-sm">No past lessons yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PolicyBadge({ mode }) {
  const map = {
    lesson:      'badge-blue',
    penalty_box: 'badge-yellow',
    standard:    'badge-green',
  };
  const label = { lesson: 'Lesson', penalty_box: 'Restricted', standard: 'Active' };
  return <span className={map[mode] || 'badge-slate'}>{label[mode] || mode}</span>;
}

function StudentRow({ student, activity, onPenalty, onRelease, penaltyLoading }) {
  const url = activity?.url;
  const ts  = activity?.ts;

  const hostname = (() => {
    try { return url ? new URL(url).hostname : null; } catch { return null; }
  })();

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <td className="px-4 py-3">
        <div className="font-medium text-sm text-slate-900">{student.name || student.email}</div>
        <div className="text-xs text-slate-400">{student.email}</div>
      </td>
      <td className="px-4 py-3">
        <PolicyBadge mode={student.policy_mode || 'standard'} />
      </td>
      <td className="px-4 py-3 max-w-xs">
        {hostname ? (
          <div>
            <div className="text-sm text-slate-700 truncate">{hostname}</div>
            {ts && (
              <div className="text-xs text-slate-400">
                {new Date(ts).toLocaleTimeString()}
              </div>
            )}
          </div>
        ) : (
          <span className="text-slate-400 text-xs">No activity yet</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          {student.policy_mode === 'penalty_box' ? (
            <button
              onClick={() => onRelease(student.id)}
              disabled={penaltyLoading}
              className="btn btn-sm btn-secondary"
            >
              Release
            </button>
          ) : (
            <button
              onClick={() => onPenalty(student.id)}
              disabled={penaltyLoading}
              className="btn btn-sm btn-warning"
            >
              Restrict
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function ClassDetail() {
  const { classId }    = useParams();
  const navigate       = useNavigate();
  const { socket }     = useSocket();
  const queryClient    = useQueryClient();
  const [showModal, setShowModal]   = useState(false);
  const [activity, setActivity]     = useState({}); // { studentId: { url, title, ts } }
  const [tab, setTab]               = useState('roster');

  const { data: cls, isLoading } = useQuery({
    queryKey: ['class', classId],
    queryFn:  () => api.get(`/classes/${classId}`),
  });

  // Real-time activity feed
  useEffect(() => {
    if (!socket) return;
    socket.emit('join:class', classId);

    const handler = (data) => {
      setActivity(prev => ({ ...prev, [data.studentId]: data }));
    };
    socket.on('student:activity', handler);

    return () => {
      socket.off('student:activity', handler);
      socket.emit('leave:class', classId);
    };
  }, [socket, classId]);

  const startLesson = useMutation({
    mutationFn: (body) => api.post(`/classes/${classId}/lessons`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['class', classId] });
      queryClient.invalidateQueries({ queryKey: ['class-lesson', classId] });
      setShowModal(false);
      navigate(`/classes/${classId}/lesson`);
    },
  });

  const endLesson = useMutation({
    mutationFn: (lessonId) => api.delete(`/classes/${classId}/lessons/${lessonId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['class', classId] });
      queryClient.invalidateQueries({ queryKey: ['class-lesson', classId] });
    },
  });

  const placePenalty = useMutation({
    mutationFn: (studentId) => api.post('/penalty-box', { student_id: studentId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['class', classId] }),
  });

  const releasePenalty = useMutation({
    mutationFn: (studentId) => api.delete(`/penalty-box/${studentId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['class', classId] }),
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto animate-pulse">
        <div className="h-6 bg-slate-100 rounded w-48 mb-4" />
        <div className="card h-64" />
      </div>
    );
  }

  if (!cls) return <div className="p-6 text-red-600">Class not found</div>;

  const members  = cls.members || [];
  const hasLesson = !!cls.active_lesson;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link to="/classes" className="text-slate-400 hover:text-slate-600 text-sm">← Classes</Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-2xl font-bold text-slate-900">{cls.name}</h1>
      </div>

      {/* Lesson banner */}
      {hasLesson && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-5 flex items-center justify-between">
          <div>
            <span className="font-semibold text-blue-900 text-sm">
              🎓 Lesson active{cls.active_lesson?.name ? `: ${cls.active_lesson.name}` : ''}
            </span>
            <p className="text-xs text-blue-600 mt-0.5">
              {(cls.active_lesson?.allowed_domains || []).length > 0
                ? `Allowed: ${(cls.active_lesson.allowed_domains).slice(0,3).join(', ')}${cls.active_lesson.allowed_domains.length > 3 ? ' +more' : ''}`
                : 'All web access blocked'}
            </p>
          </div>
          <div className="flex gap-2">
            <Link to={`/classes/${classId}/lesson`} className="btn btn-sm btn-primary">
              Monitor
            </Link>
            <button
              onClick={() => endLesson.mutate(cls.active_lesson.id)}
              disabled={endLesson.isPending}
              className="btn btn-sm btn-secondary"
            >
              End Lesson
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-slate-200">
        <button
          onClick={() => setTab('roster')}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === 'roster' ? 'border-primary-600 text-primary-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
          Roster
        </button>
        <button
          onClick={() => setTab('history')}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === 'history' ? 'border-primary-600 text-primary-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
          Past Lessons
        </button>
      </div>

      {tab === 'roster' ? (
        <>
          {/* Action bar */}
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-slate-500">{members.length} student{members.length !== 1 ? 's' : ''}</p>
            {!hasLesson && (
              <button onClick={() => setShowModal(true)} className="btn-primary">
                ▶ Start Lesson
              </button>
            )}
          </div>

          {/* Student table */}
          <div className="card overflow-hidden">
            {members.length === 0 ? (
              <div className="p-10 text-center text-slate-500">
                <div className="text-3xl mb-2">👤</div>
                <p className="font-medium">No students in this class</p>
              </div>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Student</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Current Site</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {members.map(student => (
                    <StudentRow
                      key={student.id}
                      student={student}
                      activity={activity[student.id]}
                      onPenalty={(id) => placePenalty.mutate(id)}
                      onRelease={(id) => releasePenalty.mutate(id)}
                      penaltyLoading={placePenalty.isPending || releasePenalty.isPending}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <PastLessonsTab classId={classId} />
      )}

      {showModal && (
        <StartLessonModal
          onStart={(body) => startLesson.mutate(body)}
          onClose={() => setShowModal(false)}
          loading={startLesson.isPending}
        />
      )}
    </div>
  );
}
