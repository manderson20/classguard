import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';
import StartLessonModal from '../components/StartLessonModal';

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

  const { data: cls, isLoading } = useQuery({
    queryKey: ['class', classId],
    queryFn:  () => api.get(`/classes/${classId}`),
  });

  const { data: lesson } = useQuery({
    queryKey:        ['class-lesson', classId],
    queryFn:         () => api.get(`/classes/${classId}`).then(c => c.active_lesson || null),
    refetchInterval: 10_000,
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
