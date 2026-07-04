import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '../../lib/api';
import StartSessionModal from '../../components/StartPulseSessionModal';

function LessonCard({ lesson, onStart }) {
  const statusColors = {
    draft:     'bg-slate-100 text-slate-500',
    published: 'bg-emerald-50 text-emerald-700',
    archived:  'bg-amber-50 text-amber-600',
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex flex-col gap-3 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold text-slate-800 text-sm leading-snug line-clamp-2 flex-1">
          {lesson.title}
        </h3>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 capitalize ${statusColors[lesson.status] || statusColors.draft}`}>
          {lesson.status}
        </span>
      </div>

      {lesson.subject && (
        <p className="text-xs text-slate-400">{lesson.subject}{lesson.grade_level ? ` · ${lesson.grade_level}` : ''}</p>
      )}

      {lesson.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {lesson.tags.slice(0, 3).map(t => (
            <span key={t} className="text-[11px] bg-indigo-50 text-indigo-600 rounded-full px-2 py-0.5">{t}</span>
          ))}
        </div>
      )}

      <div className="flex gap-2 mt-auto pt-1">
        <Link
          to={`/classpulse/lessons/${lesson.id}/edit`}
          className="btn btn-secondary text-xs py-1.5 flex-1 text-center"
        >
          Edit
        </Link>
        <button
          onClick={() => onStart(lesson)}
          className="btn btn-primary text-xs py-1.5 flex-1"
        >
          ▶ Start
        </button>
      </div>
    </div>
  );
}

export default function ClassPulseHub() {
  const [startLesson, setStartLesson] = useState(null);

  const { data: lessons = [], isLoading } = useQuery({
    queryKey: ['classpulse-lessons'],
    queryFn:  () => api.get('/classpulse/lessons?status=published&limit=6'),
  });

  const { data: allLessons } = useQuery({
    queryKey: ['classpulse-lessons-all'],
    queryFn:  () => api.get('/classpulse/lessons'),
  });

  const stats = {
    total:     allLessons?.length ?? 0,
    published: allLessons?.filter(l => l.status === 'published').length ?? 0,
    drafts:    allLessons?.filter(l => l.status === 'draft').length ?? 0,
  };

  const { data: sessions = [] } = useQuery({
    queryKey: ['classpulse-sessions'],
    queryFn:  () => api.get('/classpulse/sessions?limit=8'),
    // Live-session banner must reflect right-now state, not the app-default
    // 60s stale cache.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const liveSessions = sessions.filter(s => s.status === 'active');

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">ClassPulse</h1>
          <p className="text-sm text-slate-500 mt-0.5">Interactive lessons and live formative assessment</p>
        </div>
        <Link to="/classpulse/lessons/new" className="btn btn-primary">
          + New Lesson
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Lessons',   value: stats.total,     color: 'text-slate-700' },
          { label: 'Published',       value: stats.published, color: 'text-emerald-600' },
          { label: 'Drafts',          value: stats.drafts,    color: 'text-amber-600' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 p-4 text-center">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Live session banner — the way back in after closing the teach tab */}
      {liveSessions.map(s => (
        <div key={s.id} className="bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-emerald-800">
                {s.lesson_title || 'Live session'} <span className="font-normal">is live now</span>
              </p>
              <p className="text-xs text-emerald-600">
                {s.class_name ? `${s.class_name} · ` : ''}Join code {s.join_code?.toUpperCase()} · {s.student_count} joined
              </p>
            </div>
          </div>
          <Link to={`/classpulse/sessions/${s.id}/teach`} className="btn btn-primary text-sm flex-shrink-0">
            Rejoin session
          </Link>
        </div>
      ))}

      {/* Published lessons */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-700">Published Lessons</h2>
          <Link to="/classpulse/lessons" className="text-xs text-indigo-600 hover:underline">
            View all →
          </Link>
        </div>

        {isLoading ? (
          <div className="text-sm text-slate-400 py-8 text-center">Loading…</div>
        ) : lessons.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center">
            <p className="text-slate-400 text-sm mb-3">No published lessons yet</p>
            <Link to="/classpulse/lessons/new" className="btn btn-primary text-sm">
              Create your first lesson
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {lessons.map(l => (
              <LessonCard key={l.id} lesson={l} onStart={setStartLesson} />
            ))}
          </div>
        )}
      </div>

      {/* Recent sessions — stored results stay reachable after class ends */}
      {sessions.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Recent Sessions</h2>
          <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {sessions.map(s => (
              <Link
                key={s.id}
                to={s.status === 'active'
                  ? `/classpulse/sessions/${s.id}/teach`
                  : `/classpulse/sessions/${s.id}/results`}
                className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-slate-50 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700 truncate">
                    {s.lesson_title || 'Untitled lesson'}
                    {s.status === 'active' && (
                      <span className="ml-2 text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">LIVE</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-400">
                    {s.class_name ? `${s.class_name} · ` : ''}
                    {new Date(s.started_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-xs text-slate-500">{s.student_count} students · {s.response_count} answers</p>
                  <p className="text-[11px] text-indigo-600 font-medium">
                    {s.status === 'active' ? 'Rejoin →' : 'View results →'}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Quick links */}
      <div className="bg-indigo-50 rounded-2xl p-5 flex flex-wrap gap-4">
        <div className="flex-1 min-w-48">
          <h3 className="text-sm font-semibold text-indigo-800 mb-1">Lesson Library</h3>
          <p className="text-xs text-indigo-600 mb-3">Browse all your lessons, search by tag, filter by status</p>
          <Link to="/classpulse/lessons" className="text-xs font-semibold text-indigo-700 hover:underline">
            Open library →
          </Link>
        </div>
        <div className="flex-1 min-w-48">
          <h3 className="text-sm font-semibold text-indigo-800 mb-1">New Lesson</h3>
          <p className="text-xs text-indigo-600 mb-3">Build a multi-page lesson with questions from scratch</p>
          <Link to="/classpulse/lessons/new" className="text-xs font-semibold text-indigo-700 hover:underline">
            Start building →
          </Link>
        </div>
      </div>

      {startLesson && (
        <StartSessionModal lesson={startLesson} onClose={() => setStartLesson(null)} />
      )}
    </div>
  );
}
