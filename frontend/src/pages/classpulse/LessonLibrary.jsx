import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import StartSessionModal from '../../components/StartPulseSessionModal';

const STATUS_LABELS = { draft: 'Draft', published: 'Published', archived: 'Archived' };
const STATUS_COLORS = {
  draft:     'bg-slate-100 text-slate-500',
  published: 'bg-emerald-50 text-emerald-700',
  archived:  'bg-amber-50 text-amber-600',
};

export default function LessonLibrary() {
  const qc = useQueryClient();
  const [search, setSearch]       = useState('');
  const [filterStatus, setStatus] = useState('');
  const [filterTag, setTag]       = useState('');
  const [startLesson, setStart]   = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const params = new URLSearchParams();
  if (search)       params.set('search', search);
  if (filterStatus) params.set('status', filterStatus);
  if (filterTag)    params.set('tag', filterTag);

  const { data: lessons = [], isLoading } = useQuery({
    queryKey: ['classpulse-lessons', search, filterStatus, filterTag],
    queryFn:  () => api.get(`/classpulse/lessons?${params}`),
  });

  const allTags = [...new Set(lessons.flatMap(l => l.tags || []))].sort();

  const duplicate = useMutation({
    mutationFn: id => api.post(`/classpulse/lessons/${id}/duplicate`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['classpulse-lessons'] }),
  });

  const archive = useMutation({
    mutationFn: id => api.put(`/classpulse/lessons/${id}/archive`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['classpulse-lessons'] }),
  });

  const remove = useMutation({
    mutationFn: id => api.delete(`/classpulse/lessons/${id}`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['classpulse-lessons'] });
      setConfirmDelete(null);
    },
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-slate-800">Lesson Library</h1>
        <Link to="/classpulse/lessons/new" className="btn btn-primary">+ New Lesson</Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search lessons…"
          className="input flex-1 min-w-48"
        />
        <select value={filterStatus} onChange={e => setStatus(e.target.value)} className="input w-40">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
        {allTags.length > 0 && (
          <select value={filterTag} onChange={e => setTag(e.target.value)} className="input w-40">
            <option value="">All tags</option>
            {allTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-sm text-slate-400 py-10 text-center">Loading…</div>
      ) : lessons.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
          <p className="text-slate-400 text-sm mb-3">
            {search || filterStatus || filterTag ? 'No lessons match your filters' : 'No lessons yet'}
          </p>
          {!search && !filterStatus && !filterTag && (
            <Link to="/classpulse/lessons/new" className="btn btn-primary text-sm">Create your first lesson</Link>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left">
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Title</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide hidden sm:table-cell">Subject</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide hidden md:table-cell">Tags</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lessons.map(lesson => (
                <tr key={lesson.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      to={`/classpulse/lessons/${lesson.id}/edit`}
                      className="font-medium text-slate-800 hover:text-indigo-600 line-clamp-1"
                    >
                      {lesson.title}
                    </Link>
                    {lesson.description && (
                      <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{lesson.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500 hidden sm:table-cell">
                    {lesson.subject || <span className="text-slate-300">—</span>}
                    {lesson.grade_level && <span className="ml-1 text-slate-400">· {lesson.grade_level}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[lesson.status] || STATUS_COLORS.draft}`}>
                      {STATUS_LABELS[lesson.status] || lesson.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {(lesson.tags || []).slice(0, 3).map(t => (
                        <span key={t} className="text-[10px] bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">{t}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => setStart(lesson)}
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium px-2 py-1 rounded hover:bg-indigo-50"
                      >
                        ▶ Start
                      </button>
                      <Link
                        to={`/classpulse/lessons/${lesson.id}/edit`}
                        className="text-xs text-slate-500 hover:text-slate-700 font-medium px-2 py-1 rounded hover:bg-slate-100"
                      >
                        Edit
                      </Link>
                      <button
                        onClick={() => duplicate.mutate(lesson.id)}
                        disabled={duplicate.isPending}
                        className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100"
                        title="Duplicate"
                      >
                        ⧉
                      </button>
                      {lesson.status !== 'archived' && (
                        <button
                          onClick={() => archive.mutate(lesson.id)}
                          disabled={archive.isPending}
                          className="text-xs text-slate-500 hover:text-amber-600 px-2 py-1 rounded hover:bg-amber-50"
                          title="Archive"
                        >
                          ⬇
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmDelete(lesson)}
                        className="text-xs text-slate-400 hover:text-rose-600 px-2 py-1 rounded hover:bg-rose-50"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirm modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 text-center">
            <div className="text-3xl mb-3">🗑️</div>
            <h2 className="text-lg font-bold text-slate-800 mb-1">Delete lesson?</h2>
            <p className="text-sm text-slate-500 mb-5">
              "<span className="font-medium">{confirmDelete.title}</span>" will be permanently deleted.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)} className="btn btn-secondary flex-1">Cancel</button>
              <button
                onClick={() => remove.mutate(confirmDelete.id)}
                disabled={remove.isPending}
                className="btn btn-danger flex-1"
              >
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {startLesson && (
        <StartSessionModal lesson={startLesson} onClose={() => setStart(null)} />
      )}
    </div>
  );
}
