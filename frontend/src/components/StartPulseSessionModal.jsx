import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

// Shared "Start session" modal for ClassPulse — used by the Hub, the Lesson
// Library, and the Lesson Builder's Present button, so the launch flow is
// identical no matter where a teacher is when they decide to go live.
export default function StartPulseSessionModal({ lesson, onClose }) {
  const navigate = useNavigate();
  const [classId, setClassId]         = useState('');
  const [lockEnabled, setLockEnabled] = useState(false);
  const [starting, setStarting]       = useState(false);
  const [error, setError]             = useState(null);

  const { data: classes = [] } = useQuery({
    queryKey: ['classes'],
    queryFn:  () => api.get('/classes'),
  });

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const session = await api.post('/classpulse/sessions/start', {
        lesson_id: lesson.id,
        class_id:  classId || null,
        mode: 'teacher_paced',
        classroom_lock_enabled: lockEnabled,
      });
      if (lockEnabled) await api.post(`/classpulse/sessions/${session.id}/lock`, {});
      navigate(`/classpulse/sessions/${session.id}/teach`);
    } catch (e) {
      setError(e.message || 'Failed to start session');
      setStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-lg font-bold text-slate-800">Start session</h2>
          <p className="text-sm text-slate-500 mt-0.5 truncate">{lesson.title}</p>
        </div>
        <div className="px-6 pb-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Class (optional)</label>
            <select
              value={classId}
              onChange={e => setClassId(e.target.value)}
              className="input w-full"
            >
              <option value="">No class / open session</option>
              {classes.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={lockEnabled}
              onChange={e => setLockEnabled(e.target.checked)}
              className="w-4 h-4 text-indigo-600 rounded"
            />
            <div>
              <p className="text-sm font-medium text-slate-700">Focus students on this session</p>
              <p className="text-xs text-slate-400">
                Opens the session on class members' devices and keeps them there
                (requires the ClassGuard extension on managed devices)
              </p>
            </div>
          </label>

          {error && (
            <p className="text-sm text-rose-600">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="btn btn-secondary flex-1" disabled={starting}>
              Cancel
            </button>
            <button onClick={start} className="btn btn-primary flex-1" disabled={starting}>
              {starting ? 'Starting…' : 'Start'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
