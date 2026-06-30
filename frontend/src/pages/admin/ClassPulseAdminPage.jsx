import { useState, useEffect } from 'react';
import api from '../../lib/api';

const DEFAULTS = {
  classpulse_response_retention_days: '90',
  classpulse_lesson_sharing: 'school_wide',
  classpulse_drawing_enabled: 'false',
};

export default function ClassPulseAdminPage() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState(null);

  useEffect(() => {
    api.get('/settings/classpulse-admin')
      .then(data => {
        setSettings({
          classpulse_response_retention_days: data.classpulse_response_retention_days ?? DEFAULTS.classpulse_response_retention_days,
          classpulse_lesson_sharing:          data.classpulse_lesson_sharing          ?? DEFAULTS.classpulse_lesson_sharing,
          classpulse_drawing_enabled:         data.classpulse_drawing_enabled         ?? DEFAULTS.classpulse_drawing_enabled,
        });
      })
      .catch(e => setError(e.message || 'Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const set = (key, value) => {
    setSettings(s => ({ ...s, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/settings/classpulse-admin', settings);
      setSaved(true);
    } catch (e) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 text-sm text-slate-400">Loading…</div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ClassPulse Admin</h1>
        <p className="text-sm text-slate-500 mt-1">
          District-wide policy for the ClassPulse interactive classroom module.
        </p>
      </div>

      {/* Data retention */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100">
        <div className="px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-700">Data Retention</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Controls how long ClassPulse session responses are kept after a session ends.
            Setting 0 disables automatic purging.
          </p>
        </div>
        <div className="px-5 py-4">
          <label className="block text-sm font-medium text-slate-700 mb-2">
            Response retention period (days)
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min="0"
              max="3650"
              className="input w-32"
              value={settings.classpulse_response_retention_days}
              onChange={e => set('classpulse_response_retention_days', e.target.value)}
            />
            <span className="text-xs text-slate-400">days after session end (0 = keep forever)</span>
          </div>
        </div>
      </div>

      {/* Lesson sharing */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100">
        <div className="px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-700">Lesson Sharing</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Controls whether teachers can share their lessons with other teachers in the district.
          </p>
        </div>
        <div className="px-5 py-4 space-y-2">
          {[
            { value: 'school_wide', label: 'School-wide sharing', desc: 'Teachers can share lessons with any other teacher in the district' },
            { value: 'own_only',    label: 'Own lessons only',    desc: 'Lesson library is private to each teacher — no cross-sharing' },
          ].map(opt => (
            <label key={opt.value} className="flex items-start gap-3 cursor-pointer group">
              <input
                type="radio"
                name="lesson_sharing"
                value={opt.value}
                checked={settings.classpulse_lesson_sharing === opt.value}
                onChange={() => set('classpulse_lesson_sharing', opt.value)}
                className="mt-0.5 text-indigo-600"
              />
              <div>
                <p className="text-sm font-medium text-slate-700 group-hover:text-indigo-700 transition-colors">{opt.label}</p>
                <p className="text-xs text-slate-400">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Drawing (future) */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100 opacity-60">
        <div className="px-5 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Drawing Canvas</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Allow students to respond with freehand drawings. Coming in a future update.
            </p>
          </div>
          <span className="text-[10px] font-semibold bg-slate-100 text-slate-400 px-2 py-1 rounded-full uppercase tracking-wide">
            Planned
          </span>
        </div>
        <div className="px-5 py-4">
          <label className="flex items-center gap-3 cursor-not-allowed">
            <input type="checkbox" disabled checked={settings.classpulse_drawing_enabled === 'true'} className="w-4 h-4" />
            <span className="text-sm text-slate-400">Enable drawing responses district-wide</span>
          </label>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="btn btn-primary px-6"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {saved && <span className="text-sm text-emerald-600 font-medium">Saved</span>}
        {error && <span className="text-sm text-rose-600">{error}</span>}
      </div>

      {/* Permission note */}
      <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-5 py-4">
        <p className="text-xs font-semibold text-indigo-700 mb-1">Admin access note</p>
        <p className="text-xs text-indigo-600">
          The <strong>ClassPulse (admin config)</strong> permission controls which admin roles can see this page.
          Manage role assignments under <a href="/admin/custom-roles" className="underline">Admin → Custom Roles</a>.
          Teachers always have access to ClassPulse Hub and lessons regardless of this permission.
        </p>
      </div>
    </div>
  );
}
