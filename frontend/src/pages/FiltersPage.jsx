import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

// My Filters — a teacher's own reusable allowed-website lists ("scenes").
// Build a list once here, then apply it from Start Class (Focus mode) or the
// live-class Focus editor — the same list works across every course section
// the teacher runs. CRUD over the existing /scenes endpoints.

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

function parseDomains(raw) {
  return raw
    .split(/[\n,]+/)
    .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
}

function SceneEditor({ scene, onClose }) {
  const qc = useQueryClient();
  const isNew = !scene.id;
  const [name, setName]         = useState(scene.name || '');
  const [domains, setDomains]   = useState((scene.allowed_domains || []).join('\n'));
  const [error, setError]       = useState(null);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), allowed_domains: parseDomains(domains) };
      return isNew ? api.post('/scenes', body) : api.put(`/scenes/${scene.id}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teacher-scenes'] });
      onClose();
    },
    onError: (e) => setError(e.message || 'Save failed'),
  });

  const addQuick = (domain) => {
    setDomains(prev => {
      const list = prev.split('\n').map(d => d.trim()).filter(Boolean);
      if (list.includes(domain)) return prev;
      return [...list, domain].join('\n');
    });
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="px-6 py-5 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-800">{isNew ? 'New filter' : 'Edit filter'}</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Students in Focus mode can only reach the sites on this list.
          </p>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="label">Filter name</label>
            <input
              className="input w-full"
              placeholder="e.g. Math Research Day"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Allowed websites</label>
            <textarea
              className="input min-h-[120px] resize-y font-mono text-xs w-full"
              placeholder="khanacademy.org&#10;docs.google.com&#10;desmos.com"
              value={domains}
              onChange={e => setDomains(e.target.value)}
            />
            <p className="text-xs text-slate-400 mt-1">One domain per line.</p>
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
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="btn btn-secondary flex-1" disabled={save.isPending}>Cancel</button>
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending || !name.trim() || parseDomains(domains).length === 0}
              className="btn btn-primary flex-1 disabled:opacity-40"
            >
              {save.isPending ? 'Saving…' : 'Save filter'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FiltersPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null); // scene object or {} for new

  const { data: scenes = [], isLoading } = useQuery({
    queryKey: ['teacher-scenes'],
    queryFn:  () => api.get('/scenes'),
  });

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/scenes/${id}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['teacher-scenes'] }),
  });

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">My Filters</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Reusable allowed-website lists for Focus mode — build once, use across every class you teach.
          </p>
        </div>
        <button onClick={() => setEditing({})} className="btn btn-primary">+ New Filter</button>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700">
        Apply a filter when you <strong>Start Class</strong> (choose Focus) or mid-class from the
        <strong> Focus</strong> button on the live-class toolbar. Monitor-only classes leave students
        on their normal school filtering.
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-400 text-center py-10">Loading…</p>
      ) : scenes.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
          <p className="text-slate-400 text-sm mb-3">No filters yet — build your first reusable site list.</p>
          <button onClick={() => setEditing({})} className="btn btn-primary text-sm">Create a filter</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {scenes.map(s => (
            <div key={s.id} className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-800 truncate">{s.name}</h2>
                <span className="text-xs text-slate-400 flex-shrink-0">
                  {(s.allowed_domains || []).length} site{(s.allowed_domains || []).length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {(s.allowed_domains || []).slice(0, 6).map(d => (
                  <span key={d} className="text-[11px] font-mono bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{d}</span>
                ))}
                {(s.allowed_domains || []).length > 6 && (
                  <span className="text-[11px] text-slate-400">+{s.allowed_domains.length - 6} more</span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-4">
                <button
                  onClick={() => setEditing(s)}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded hover:bg-indigo-50"
                >
                  Edit
                </button>
                <button
                  onClick={() => { if (window.confirm(`Delete filter "${s.name}"?`)) remove.mutate(s.id); }}
                  className="text-xs text-slate-400 hover:text-rose-600 px-2 py-1 rounded hover:bg-rose-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <SceneEditor scene={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
