import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';

function StudentTile({ student, activity, onRestrict, onRelease }) {
  const [highlight, setHighlight] = useState(false);
  const prevUrl = useRef(null);

  useEffect(() => {
    if (activity?.url && activity.url !== prevUrl.current) {
      prevUrl.current = activity.url;
      setHighlight(true);
      const t = setTimeout(() => setHighlight(false), 2000);
      return () => clearTimeout(t);
    }
  }, [activity?.url]);

  const hostname = (() => {
    try { return activity?.url ? new URL(activity.url).hostname : null; } catch { return null; }
  })();

  const isRestricted = student.policy_mode === 'penalty_box';

  return (
    <div className={`card p-4 transition-all ${highlight ? 'ring-2 ring-blue-400' : ''} ${isRestricted ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-sm text-slate-800 truncate pr-2">
          {student.given_name || student.name?.split(' ')[0] || student.email}
        </div>
        {isRestricted ? (
          <button onClick={() => onRelease(student.id)} className="btn btn-sm btn-secondary flex-shrink-0">Release</button>
        ) : (
          <button onClick={() => onRestrict(student.id)} className="btn btn-sm text-xs px-2 py-1 text-amber-700 border border-amber-300 rounded-md hover:bg-amber-50 flex-shrink-0">
            Restrict
          </button>
        )}
      </div>

      <div className="min-h-[36px]">
        {isRestricted ? (
          <span className="text-xs text-amber-600 font-medium">⚠️ Restricted</span>
        ) : hostname ? (
          <div>
            <div className="text-xs font-mono text-primary-700 truncate">{hostname}</div>
            {activity?.ts && (
              <div className="text-xs text-slate-400 mt-0.5">{new Date(activity.ts).toLocaleTimeString()}</div>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-400">Waiting for activity…</span>
        )}
      </div>
    </div>
  );
}

export default function ActiveLesson() {
  const { classId }   = useParams();
  const navigate      = useNavigate();
  const { socket }    = useSocket();
  const queryClient   = useQueryClient();
  const [activity, setActivity] = useState({});

  const { data: cls } = useQuery({
    queryKey:        ['class', classId],
    queryFn:         () => api.get(`/classes/${classId}`),
    refetchInterval: 15_000,
  });

  // Real-time feed
  useEffect(() => {
    if (!socket) return;
    socket.emit('join:class', classId);
    const handler = (data) => setActivity(prev => ({ ...prev, [data.studentId]: data }));
    socket.on('student:activity', handler);
    return () => { socket.off('student:activity', handler); socket.emit('leave:class', classId); };
  }, [socket, classId]);

  const endLesson = useMutation({
    mutationFn: (lessonId) => api.delete(`/classes/${classId}/lessons/${lessonId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['class', classId] });
      navigate(`/classes/${classId}`);
    },
  });

  const restrict = useMutation({
    mutationFn: (studentId) => api.post('/penalty-box', { student_id: studentId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['class', classId] }),
  });

  const release = useMutation({
    mutationFn: (studentId) => api.delete(`/penalty-box/${studentId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['class', classId] }),
  });

  if (!cls) return null;

  const members    = cls.members || [];
  const lesson     = cls.active_lesson;
  const allowed    = lesson?.allowed_domains || [];
  const activeCount = members.filter(m => activity[m.id]).length;

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="bg-blue-700 text-white px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-4">
          <Link to={`/classes/${classId}`} className="text-blue-200 hover:text-white text-sm">← {cls.name}</Link>
          <div>
            <span className="font-bold">{lesson?.name || 'Active Lesson'}</span>
            <span className="text-blue-300 text-sm ml-3">{activeCount} / {members.length} online</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {allowed.length > 0 && (
            <span className="text-xs text-blue-200">
              {allowed.slice(0,3).join(' · ')}{allowed.length > 3 ? ` +${allowed.length - 3}` : ''}
            </span>
          )}
          <button
            onClick={() => lesson && endLesson.mutate(lesson.id)}
            disabled={endLesson.isPending || !lesson}
            className="btn btn-sm bg-red-600 text-white hover:bg-red-700 border-0"
          >
            ■ End Lesson
          </button>
        </div>
      </div>

      {/* Student grid */}
      <div className="flex-1 overflow-auto p-5">
        {members.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-400">
            No students in this class
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {members.map(student => (
              <StudentTile
                key={student.id}
                student={student}
                activity={activity[student.id]}
                onRestrict={(id) => restrict.mutate(id)}
                onRelease={(id) => release.mutate(id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Activity log sidebar — latest events */}
      <div className="flex-shrink-0 bg-slate-800 text-white px-4 py-2 text-xs font-mono max-h-28 overflow-y-auto">
        <div className="text-slate-400 mb-1">Recent navigation</div>
        {Object.entries(activity)
          .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
          .slice(0, 20)
          .map(([studentId, ev]) => {
            const student = members.find(m => m.id === studentId);
            const name    = student?.given_name || student?.name?.split(' ')[0] || '?';
            let host = ev.url;
            try { host = new URL(ev.url).hostname; } catch {}
            return (
              <div key={`${studentId}-${ev.ts}`} className="text-slate-300">
                <span className="text-primary-400">{name}</span>
                {' → '}
                <span>{host}</span>
              </div>
            );
          })}
        {Object.keys(activity).length === 0 && (
          <div className="text-slate-500">Waiting for student activity…</div>
        )}
      </div>
    </div>
  );
}
