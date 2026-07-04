import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

const QUICK_ADD = [
  { label: 'Khan Academy', domain: 'khanacademy.org' },
  { label: 'Google Docs',  domain: 'docs.google.com' },
  { label: 'Google Drive', domain: 'drive.google.com' },
  { label: 'YouTube Edu',  domain: 'youtube.com' },
  { label: 'Desmos',       domain: 'desmos.com' },
  { label: 'IXL',          domain: 'ixl.com' },
  { label: 'Duolingo',     domain: 'duolingo.com' },
  { label: 'Quizlet',      domain: 'quizlet.com' },
];

export default function StartLessonModal({ onStart, onClose, loading }) {
  const [name,    setName]    = useState('');
  const [domains, setDomains] = useState('');
  const [saveOpen,  setSaveOpen]  = useState(false);
  const [sceneName, setSceneName] = useState('');
  const [sceneErr,  setSceneErr]  = useState(null);
  const inputRef = useRef(null);
  const qc = useQueryClient();

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Scenes: the teacher's own saved allowed-site lists, reusable across
  // lessons — applying one just fills the textarea, so it stays editable
  // before starting.
  const { data: scenes = [] } = useQuery({
    queryKey: ['teacher-scenes'],
    queryFn:  () => api.get('/scenes'),
  });

  const parseDomains = (raw) => raw
    .split(/[\n,]+/)
    .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);

  const saveScene = useMutation({
    mutationFn: () => api.post('/scenes', {
      name: sceneName.trim(),
      allowed_domains: parseDomains(domains),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teacher-scenes'] });
      setSaveOpen(false);
      setSceneName('');
      setSceneErr(null);
    },
    onError: (e) => setSceneErr(e.message || 'Failed to save scene'),
  });

  const deleteScene = useMutation({
    mutationFn: (id) => api.delete(`/scenes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-scenes'] }),
  });

  const applyScene = (scene) => {
    setDomains((scene.allowed_domains || []).join('\n'));
    if (!name) setName(scene.name);
  };

  const addQuick = (domain) => {
    setDomains(prev => {
      const list = prev.split('\n').map(d => d.trim()).filter(Boolean);
      if (list.includes(domain)) return prev;
      return [...list, domain].join('\n');
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onStart({ name: name.trim() || null, allowed_domains: parseDomains(domains) });
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-5 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-900">Start Lesson</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Students will only be able to access the domains you list below.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className="label">Lesson name <span className="font-normal text-slate-400">(optional)</span></label>
            <input
              ref={inputRef}
              className="input"
              placeholder="e.g. Chapter 7 Research"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          {/* Scenes — saved site lists */}
          {scenes.length > 0 && (
            <div>
              <p className="label mb-2">My scenes</p>
              <div className="flex flex-wrap gap-1.5">
                {scenes.map(s => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 text-xs rounded-full
                               border border-indigo-200 bg-indigo-50 text-indigo-700"
                  >
                    <button
                      type="button"
                      onClick={() => applyScene(s)}
                      title={`Apply "${s.name}" (${(s.allowed_domains || []).length} sites)`}
                      className="hover:underline font-medium"
                    >
                      {s.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => { if (window.confirm(`Delete scene "${s.name}"?`)) deleteScene.mutate(s.id); }}
                      title="Delete scene"
                      className="text-indigo-300 hover:text-rose-500 leading-none"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="label">Allowed websites</label>
            <textarea
              className="input min-h-[100px] resize-none font-mono text-xs"
              placeholder="khanacademy.org&#10;docs.google.com&#10;desmos.com"
              value={domains}
              onChange={e => setDomains(e.target.value)}
            />
            <p className="text-xs text-slate-400 mt-1">
              One domain per line. Leaving this empty blocks all browsing for the lesson.
            </p>
          </div>

          <div>
            <p className="label mb-2">Quick add</p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_ADD.map(({ label, domain }) => (
                <button
                  key={domain}
                  type="button"
                  onClick={() => addQuick(domain)}
                  className="px-2.5 py-1 text-xs rounded-full border border-slate-200 text-slate-600
                             hover:border-primary-400 hover:text-primary-700 hover:bg-primary-50 transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Save current list as a scene */}
          {parseDomains(domains).length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
              {saveOpen ? (
                <div className="space-y-2">
                  <input
                    className="input text-sm py-1.5"
                    placeholder="Scene name, e.g. Math Research Day"
                    value={sceneName}
                    onChange={e => setSceneName(e.target.value)}
                    onKeyDown={e => {
                      // Enter here must save the scene, not submit the
                      // surrounding start-lesson form (which would start the
                      // class instead).
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (sceneName.trim() && !saveScene.isPending) saveScene.mutate();
                      }
                    }}
                  />
                  {sceneErr && <p className="text-xs text-rose-600">{sceneErr}</p>}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setSaveOpen(false); setSceneErr(null); }}
                      className="btn-secondary flex-1 text-xs py-1.5"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!sceneName.trim() || saveScene.isPending}
                      onClick={() => saveScene.mutate()}
                      className="btn-primary flex-1 text-xs py-1.5 disabled:opacity-40"
                    >
                      {saveScene.isPending ? 'Saving…' : 'Save scene'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setSaveOpen(true)}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
                >
                  💾 Save this site list as a scene for reuse
                </button>
              )}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={loading}>
              {loading ? 'Starting…' : '▶ Start Lesson'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
