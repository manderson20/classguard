import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import StartSessionModal from '../../components/StartPulseSessionModal';

const STATUS_LABELS = { draft: 'Draft', published: 'Published', archived: 'Archived' };
const STATUS_COLORS = {
  draft:     'bg-slate-100 text-slate-500',
  published: 'bg-emerald-50 text-emerald-700',
  archived:  'bg-amber-50 text-amber-600',
};

// ---------------------------------------------------------------------------
// Share dialog — school-wide or specific staff; lists + revokes existing
// shares. Backend enforces the district sharing policy and ownership.
// ---------------------------------------------------------------------------
function ShareLessonModal({ lesson, onClose }) {
  const qc = useQueryClient();
  const [staffSearch, setStaffSearch] = useState('');
  const [error, setError] = useState(null);

  const { data: shares = [] } = useQuery({
    queryKey: ['lesson-shares', lesson.id],
    queryFn:  () => api.get(`/classpulse/lessons/${lesson.id}/shares`),
  });

  const { data: staff = [] } = useQuery({
    queryKey: ['staff-directory', staffSearch],
    queryFn:  () => api.get(`/classpulse/staff-directory?search=${encodeURIComponent(staffSearch)}`),
    enabled:  staffSearch.trim().length >= 2,
  });

  // Optimistic school-wide toggle: flip the cached shares list immediately so
  // the checkbox responds on click, then reconcile with the server refetch.
  const addShare = useMutation({
    mutationFn: (userId) => api.post(`/classpulse/lessons/${lesson.id}/share`, { user_id: userId }),
    onMutate:   (userId) => {
      if (userId === null) {
        qc.setQueryData(['lesson-shares', lesson.id], (prev = []) =>
          prev.some(sh => sh.shared_with === null) ? prev : [...prev, { id: '_optimistic', shared_with: null }]);
      }
    },
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['lesson-shares', lesson.id] }); setError(null); setStaffSearch(''); },
    onError:    (e) => { setError(e.message || 'Share failed'); qc.invalidateQueries({ queryKey: ['lesson-shares', lesson.id] }); },
  });

  const removeShare = useMutation({
    mutationFn: (userId) => api.delete(`/classpulse/lessons/${lesson.id}/share`, { user_id: userId }),
    onMutate:   (userId) => {
      qc.setQueryData(['lesson-shares', lesson.id], (prev = []) =>
        prev.filter(sh => sh.shared_with !== userId));
    },
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['lesson-shares', lesson.id] }),
    onError:    () => qc.invalidateQueries({ queryKey: ['lesson-shares', lesson.id] }),
  });

  const schoolWide = shares.some(sh => sh.shared_with === null);
  const alreadySharedIds = new Set(shares.map(sh => sh.shared_with));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        <div className="px-6 py-5 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-800">Share lesson</h2>
          <p className="text-sm text-slate-500 mt-0.5 truncate">{lesson.title}</p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* School-wide toggle */}
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={schoolWide}
              onChange={e => e.target.checked ? addShare.mutate(null) : removeShare.mutate(null)}
              className="w-4 h-4 text-indigo-600 rounded"
            />
            <div>
              <p className="text-sm font-medium text-slate-700">Share with all staff</p>
              <p className="text-xs text-slate-400">Every teacher sees this lesson in their library (read/duplicate)</p>
            </div>
          </label>

          {/* Individual shares */}
          <div>
            <p className="label mb-2">Share with a specific person</p>
            <input
              className="input w-full text-sm"
              placeholder="Type a name or email (min 2 letters)…"
              value={staffSearch}
              onChange={e => setStaffSearch(e.target.value)}
            />
            {staffSearch.trim().length >= 2 && (
              <div className="mt-2 border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-44 overflow-y-auto">
                {staff.length === 0 && <p className="text-xs text-slate-400 px-3 py-2">No staff match</p>}
                {staff.map(u => (
                  <div key={u.id} className="flex items-center justify-between px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-700 truncate">{u.full_name}</p>
                      <p className="text-xs text-slate-400 truncate">{u.email}</p>
                    </div>
                    {alreadySharedIds.has(u.id) ? (
                      <span className="text-[10px] text-emerald-600 font-semibold flex-shrink-0">Shared</span>
                    ) : (
                      <button
                        onClick={() => addShare.mutate(u.id)}
                        disabled={addShare.isPending}
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium flex-shrink-0"
                      >
                        Share
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Current shares */}
          {shares.filter(sh => sh.shared_with !== null).length > 0 && (
            <div>
              <p className="label mb-2">Currently shared with</p>
              <div className="space-y-1">
                {shares.filter(sh => sh.shared_with !== null).map(sh => (
                  <div key={sh.id} className="flex items-center justify-between text-sm bg-slate-50 rounded-lg px-3 py-1.5">
                    <span className="text-slate-700 truncate">{sh.full_name || sh.email}</span>
                    <button
                      onClick={() => removeShare.mutate(sh.shared_with)}
                      className="text-xs text-slate-400 hover:text-rose-500 flex-shrink-0"
                      title="Stop sharing"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-rose-600">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end">
          <button onClick={onClose} className="btn btn-secondary text-sm">Done</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Move-to-folder — pick an existing folder or type a new one; empty removes
// the lesson from its folder.
// ---------------------------------------------------------------------------
function MoveToFolderModal({ lesson, folders, onMove, moving, onClose }) {
  const [name, setName] = useState(lesson.folder || '');
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <h2 className="text-lg font-bold text-slate-800 mb-1">Move to folder</h2>
        <p className="text-sm text-slate-500 mb-4 truncate">{lesson.title}</p>
        <input
          className="input w-full text-sm"
          list="cp-folder-options"
          placeholder="Folder name — leave empty for no folder"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
        />
        <datalist id="cp-folder-options">
          {folders.map(fo => <option key={fo} value={fo} />)}
        </datalist>
        <div className="flex gap-3 mt-5">
          <button onClick={onClose} className="btn btn-secondary flex-1" disabled={moving}>Cancel</button>
          <button onClick={() => onMove(name.trim())} className="btn btn-primary flex-1" disabled={moving}>
            {moving ? 'Moving…' : 'Move'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LessonLibrary() {
  const qc = useQueryClient();
  const [search, setSearch]       = useState('');
  const [filterStatus, setStatus] = useState('');
  const [filterTag, setTag]       = useState('');
  const [filterFolder, setFolder] = useState('');
  const [startLesson, setStart]   = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [shareLesson, setShareLesson]     = useState(null);
  const [moveLesson, setMoveLesson]       = useState(null);

  const params = new URLSearchParams();
  if (search)       params.set('search', search);
  if (filterStatus) params.set('status', filterStatus);
  if (filterTag)    params.set('tag', filterTag);
  if (filterFolder) params.set('folder', filterFolder);

  const { data: lessons = [], isLoading } = useQuery({
    queryKey: ['classpulse-lessons', search, filterStatus, filterTag, filterFolder],
    queryFn:  () => api.get(`/classpulse/lessons?${params}`),
  });

  // Unfiltered fetch drives the folder dropdown so folders stay visible
  // while one is selected.
  const { data: allLessons = [] } = useQuery({
    queryKey: ['classpulse-lessons-all-folders'],
    queryFn:  () => api.get('/classpulse/lessons'),
  });
  const allFolders = [...new Set(allLessons.map(l => l.folder).filter(Boolean))].sort();

  const allTags = [...new Set(lessons.flatMap(l => l.tags || []))].sort();

  const unarchive = useMutation({
    mutationFn: (lesson) => api.put(`/classpulse/lessons/${lesson.id}`, { title: lesson.title, status: 'draft' }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['classpulse-lessons'] }),
  });

  const moveToFolder = useMutation({
    mutationFn: ({ lesson, folder }) => api.put(`/classpulse/lessons/${lesson.id}`, { title: lesson.title, folder }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['classpulse-lessons'] });
      qc.invalidateQueries({ queryKey: ['classpulse-lessons-all-folders'] });
      setMoveLesson(null);
    },
  });

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
        {allFolders.length > 0 && (
          <select value={filterFolder} onChange={e => setFolder(e.target.value)} className="input w-40">
            <option value="">All folders</option>
            {allFolders.map(fo => <option key={fo} value={fo}>📁 {fo}</option>)}
          </select>
        )}
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
                    <div className="flex items-center gap-2 mt-0.5">
                      {lesson.folder && (
                        <span className="text-[10px] text-slate-400">📁 {lesson.folder}</span>
                      )}
                      {lesson.is_shared_with_me && (
                        <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">
                          Shared by {lesson.teacher_name}
                        </span>
                      )}
                    </div>
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
                      {!lesson.is_shared_with_me && (
                        <>
                          <button
                            onClick={() => setShareLesson(lesson)}
                            className="text-xs text-slate-500 hover:text-emerald-600 px-2 py-1 rounded hover:bg-emerald-50"
                            title="Share with staff"
                          >
                            Share
                          </button>
                          <button
                            onClick={() => setMoveLesson(lesson)}
                            className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100"
                            title="Move to folder"
                          >
                            📁
                          </button>
                        </>
                      )}
                      {lesson.status !== 'archived' ? (
                        !lesson.is_shared_with_me && (
                          <button
                            onClick={() => archive.mutate(lesson.id)}
                            disabled={archive.isPending}
                            className="text-xs text-slate-500 hover:text-amber-600 px-2 py-1 rounded hover:bg-amber-50"
                            title="Archive"
                          >
                            ⬇
                          </button>
                        )
                      ) : (
                        <button
                          onClick={() => unarchive.mutate(lesson)}
                          disabled={unarchive.isPending}
                          className="text-xs text-emerald-600 hover:text-emerald-800 font-medium px-2 py-1 rounded hover:bg-emerald-50"
                          title="Restore this lesson to Draft"
                        >
                          Unarchive
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

      {shareLesson && (
        <ShareLessonModal lesson={shareLesson} onClose={() => setShareLesson(null)} />
      )}

      {moveLesson && (
        <MoveToFolderModal
          lesson={moveLesson}
          folders={allFolders}
          onMove={(folder) => moveToFolder.mutate({ lesson: moveLesson, folder })}
          moving={moveToFolder.isPending}
          onClose={() => setMoveLesson(null)}
        />
      )}
    </div>
  );
}
