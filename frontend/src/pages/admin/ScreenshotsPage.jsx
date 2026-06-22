import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const TRIGGER_LABELS = {
  content_violation: { label: 'Keyword Match',    color: 'bg-red-100 text-red-700' },
  risky_category:    { label: 'Proactive Check',  color: 'bg-purple-100 text-purple-700' },
  policy_block:      { label: 'Policy Block',      color: 'bg-orange-100 text-orange-700' },
  teacher_request:   { label: 'Teacher Request',   color: 'bg-blue-100 text-blue-700' },
  manual:            { label: 'Manual',             color: 'bg-slate-100 text-slate-600' },
};

const AI_CATEGORIES = {
  adult:     { label: 'Adult',      color: 'text-red-600' },
  violence:  { label: 'Violence',   color: 'text-orange-600' },
  self_harm: { label: 'Self-harm',  color: 'text-purple-600' },
  profanity: { label: 'Profanity',  color: 'text-yellow-600' },
  other:     { label: 'Other',      color: 'text-slate-500' },
  safe:      { label: 'Safe',       color: 'text-green-600' },
};

const STATUS_LABELS = {
  new:        { label: 'New',        color: 'bg-amber-100 text-amber-700' },
  in_review:  { label: 'In Review',  color: 'bg-blue-100 text-blue-700' },
  resolved:   { label: 'Resolved',   color: 'bg-green-100 text-green-700' },
  dismissed:  { label: 'Dismissed',  color: 'bg-slate-100 text-slate-500' },
};

function riskTier(score) {
  if (score == null) return null;
  if (score >= 85) return { label: 'Urgent',       color: 'bg-red-600 text-white' };
  if (score >= 60) return { label: 'Needs Review', color: 'bg-orange-100 text-orange-700' };
  if (score >= 40) return { label: 'Logged',        color: 'bg-slate-100 text-slate-600' };
  return { label: 'Low',                            color: 'bg-slate-50 text-slate-400' };
}

function RiskBadge({ score, category }) {
  const tier = riskTier(score);
  if (!tier) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${tier.color}`}>
      {tier.label} {score != null && `(${score})`}
      {category && <span className="opacity-75 font-normal">· {category}</span>}
    </span>
  );
}

function StatusBadge({ status }) {
  const s = STATUS_LABELS[status] || STATUS_LABELS.new;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>{s.label}</span>;
}

function TriggerBadge({ trigger }) {
  const t = TRIGGER_LABELS[trigger] || { label: trigger, color: 'bg-slate-100 text-slate-600' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${t.color}`}>
      {t.label}
    </span>
  );
}

function AiResult({ flagged, category, confidence }) {
  if (flagged === null || flagged === undefined) {
    return <span className="text-xs text-slate-400">AI: not configured / pending</span>;
  }
  if (!flagged) return <span className="text-xs text-green-600 font-medium">AI: Clean</span>;
  const cat = AI_CATEGORIES[category] || { label: category, color: 'text-slate-500' };
  return (
    <span className={`text-xs font-semibold ${cat.color}`}>
      AI: {cat.label} {confidence != null && `(${Math.round(confidence * 100)}%)`}
    </span>
  );
}

function ScreenshotModal({ screenshot, onClose, onUpdate }) {
  const imgUrl = `/api/v1/extension/screenshots/${screenshot.id}/image`;
  const [notes, setNotes] = useState(screenshot.resolution_notes || '');

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between p-4 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <TriggerBadge trigger={screenshot.trigger} />
              <RiskBadge score={screenshot.risk_score} category={screenshot.risk_category} />
              <StatusBadge status={screenshot.status} />
              {screenshot.ai_flagged !== null && (
                <AiResult flagged={screenshot.ai_flagged} category={screenshot.ai_category} confidence={screenshot.ai_confidence} />
              )}
            </div>
            <div className="text-sm font-semibold text-slate-800 truncate max-w-xl">{screenshot.student_name}</div>
            <div className="text-xs text-slate-500 truncate max-w-xl">{screenshot.url}</div>
            <div className="text-xs text-slate-400 mt-0.5">{new Date(screenshot.created_at).toLocaleString()}</div>
            {screenshot.trigger_detail && (
              <div className="text-xs text-slate-500 mt-1">Detail: <span className="font-mono">{screenshot.trigger_detail}</span></div>
            )}
            {screenshot.ai_reasoning && (
              <div className="text-xs text-slate-500 mt-1 italic">AI reasoning: {screenshot.ai_reasoning}</div>
            )}
            {screenshot.assignee_name && (
              <div className="text-xs text-slate-500 mt-1">Assigned to: <span className="font-medium">{screenshot.assignee_name}</span></div>
            )}
            {screenshot.resolved_at && (
              <div className="text-xs text-slate-400 mt-1">
                {screenshot.status === 'dismissed' ? 'Dismissed' : 'Resolved'} {new Date(screenshot.resolved_at).toLocaleString()}
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none ml-4">×</button>
        </div>

        <div className="p-4">
          <img
            src={imgUrl}
            alt="Screenshot"
            className="w-full rounded border border-slate-200"
            style={{ maxHeight: '60vh', objectFit: 'contain' }}
          />
        </div>

        <div className="px-4 pb-4 space-y-3">
          <div>
            <label className="label">Notes — what was done about this</label>
            <textarea
              className="input text-sm w-full"
              rows={2}
              placeholder="e.g. spoke with student, parent contacted, no action needed…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            {screenshot.status === 'new' && (
              <button className="btn-secondary text-sm" onClick={() => onUpdate(screenshot.id, { status: 'in_review', assigned_to: 'self' })}>
                Start review (assign to me)
              </button>
            )}
            {screenshot.status !== 'resolved' && (
              <button className="btn-primary text-sm" onClick={() => onUpdate(screenshot.id, { status: 'resolved', resolution_notes: notes })}>
                Mark resolved
              </button>
            )}
            {screenshot.status !== 'dismissed' && (
              <button className="btn-secondary text-sm" onClick={() => onUpdate(screenshot.id, { status: 'dismissed', resolution_notes: notes })}>
                Dismiss (false positive)
              </button>
            )}
            {notes !== (screenshot.resolution_notes || '') && (
              <button className="text-sm text-primary-600 hover:underline" onClick={() => onUpdate(screenshot.id, { resolution_notes: notes })}>
                Save notes only
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ScreenshotsPage() {
  const qc = useQueryClient();
  const [filters, setFilters]   = useState({ trigger: '', flagged: '', status: '' });
  const [selected, setSelected] = useState(null);

  const { data: screenshots = [], isLoading } = useQuery({
    queryKey: ['screenshots', filters],
    queryFn: () => {
      const params = new URLSearchParams({ limit: 100 });
      if (filters.trigger) params.set('trigger', filters.trigger);
      if (filters.flagged) params.set('flagged', filters.flagged);
      if (filters.status) params.set('status', filters.status);
      return api.get(`/extension/screenshots?${params}`);
    },
    refetchInterval: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }) => api.patch(`/extension/screenshots/${id}`, body),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['screenshots'] }),
  });

  function handleUpdate(id, body) {
    updateMutation.mutate({ id, ...body });
    setSelected(s => s ? { ...s, ...body, resolution_notes: body.resolution_notes ?? s.resolution_notes } : s);
  }

  const newCount    = screenshots.filter(s => s.status === 'new').length;
  const urgentCount = screenshots.filter(s => s.risk_score >= 85).length;
  const aiFlags     = screenshots.filter(s => s.ai_flagged).length;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Screenshots</h1>
        <p className="text-slate-500 text-sm mt-0.5">Safety evidence — keyword matches, proactive checks, and teacher-requested captures</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Total" value={screenshots.length} />
        <StatCard label="Urgent (risk ≥85)" value={urgentCount} accent={urgentCount > 0 ? 'text-red-600' : undefined} />
        <StatCard label="New / unreviewed" value={newCount} accent={newCount > 0 ? 'text-amber-600' : undefined} />
        <StatCard label="AI Flagged" value={aiFlags} accent={aiFlags > 0 ? 'text-orange-600' : undefined} />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <select
          className="input text-sm w-44"
          value={filters.trigger}
          onChange={e => setFilters(f => ({ ...f, trigger: e.target.value }))}
        >
          <option value="">All triggers</option>
          <option value="content_violation">Keyword match</option>
          <option value="risky_category">Proactive check</option>
          <option value="policy_block">Policy block</option>
          <option value="teacher_request">Teacher request</option>
          <option value="manual">Manual</option>
        </select>

        <select
          className="input text-sm w-44"
          value={filters.status}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
        >
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="in_review">In review</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
        </select>

        <select
          className="input text-sm w-44"
          value={filters.flagged}
          onChange={e => setFilters(f => ({ ...f, flagged: e.target.value }))}
        >
          <option value="">All AI results</option>
          <option value="true">AI Flagged</option>
          <option value="false">AI Clean</option>
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : screenshots.length === 0 ? (
        <div className="card p-10 text-center text-slate-400">
          <div className="text-3xl mb-2">📸</div>
          <div className="text-sm">No screenshots yet</div>
          <div className="text-xs mt-1">Captured automatically on a flagged keyword, a proactive risky-domain check, or a teacher request.</div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Student</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">URL</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Trigger</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Risk</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Captured</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {screenshots.map(s => (
                <tr
                  key={s.id}
                  className={`hover:bg-slate-50 cursor-pointer ${s.risk_score >= 85 ? 'bg-red-50/50' : s.status === 'new' ? 'bg-amber-50/40' : ''}`}
                  onClick={() => setSelected(s)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{s.student_name}</div>
                    <div className="text-xs text-slate-400">{s.student_email}</div>
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <div className="text-xs text-slate-600 truncate">{s.url}</div>
                    {s.page_title && <div className="text-xs text-slate-400 truncate">{s.page_title}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <TriggerBadge trigger={s.trigger} />
                    {s.trigger_detail && (
                      <div className="text-xs text-slate-400 mt-0.5 font-mono truncate max-w-[160px]">{s.trigger_detail}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <RiskBadge score={s.risk_score} category={s.risk_category} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                    {new Date(s.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-3">
                    <button
                      className="text-xs text-primary-600 hover:underline"
                      onClick={e => { e.stopPropagation(); setSelected(s); }}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ScreenshotModal
          screenshot={selected}
          onClose={() => setSelected(null)}
          onUpdate={handleUpdate}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div className="card p-4">
      <div className={`text-2xl font-bold ${accent || 'text-slate-800'}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}
