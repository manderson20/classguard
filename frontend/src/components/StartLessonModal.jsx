import { useState, useEffect, useRef } from 'react';

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
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const addQuick = (domain) => {
    setDomains(prev => {
      const list = prev.split('\n').map(d => d.trim()).filter(Boolean);
      if (list.includes(domain)) return prev;
      return [...list, domain].join('\n');
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const allowedDomains = domains
      .split(/[\n,]+/)
      .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    onStart({ name: name.trim() || null, allowed_domains: allowedDomains });
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

          <div>
            <label className="label">Allowed websites</label>
            <textarea
              className="input min-h-[100px] resize-none font-mono text-xs"
              placeholder="khanacademy.org&#10;docs.google.com&#10;desmos.com"
              value={domains}
              onChange={e => setDomains(e.target.value)}
            />
            <p className="text-xs text-slate-400 mt-1">One domain per line. Leave empty to block all non-allowed traffic.</p>
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
