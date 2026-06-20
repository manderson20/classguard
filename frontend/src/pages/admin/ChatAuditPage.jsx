import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../../lib/api';

function StatCard({ label, value, accent }) {
  return (
    <div className="card p-4">
      <div className={`text-2xl font-bold ${accent || 'text-slate-800'}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

const TYPE_LABELS = {
  direct: { label: 'Direct',          color: 'bg-blue-100 text-blue-700' },
  group:  { label: 'Group',           color: 'bg-purple-100 text-purple-700' },
};

function ThreadBadge({ type, name }) {
  const t = TYPE_LABELS[type] || { label: type, color: 'bg-slate-100 text-slate-600' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${t.color}`}>
      {t.label}{name ? `: ${name}` : ''}
    </span>
  );
}

export default function ChatAuditPage() {
  const [filters, setFilters] = useState({ student_id: '', teacher_id: '', from: '', to: '' });

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['chat-audit', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.student_id) params.set('student_id', filters.student_id);
      if (filters.teacher_id) params.set('teacher_id', filters.teacher_id);
      if (filters.from) params.set('from', filters.from);
      if (filters.to)   params.set('to', filters.to);
      return api.get(`/chat/admin/messages?${params}`);
    },
    refetchInterval: 30_000,
  });

  const deletedCount = messages.filter(m => m.deleted_at).length;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Chat Audit</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Every message exchanged between staff and students, including ones a participant deleted —
          deletion only hides a message from the people in the thread, never from this view.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6 max-w-md">
        <StatCard label="Total messages" value={messages.length} />
        <StatCard label="Deleted (still visible here)" value={deletedCount} accent={deletedCount > 0 ? 'text-red-600' : undefined} />
      </div>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          className="input text-sm w-56"
          placeholder="Student user ID"
          value={filters.student_id}
          onChange={e => setFilters(f => ({ ...f, student_id: e.target.value }))}
        />
        <input
          className="input text-sm w-56"
          placeholder="Teacher user ID"
          value={filters.teacher_id}
          onChange={e => setFilters(f => ({ ...f, teacher_id: e.target.value }))}
        />
        <input
          type="date"
          className="input text-sm"
          value={filters.from}
          onChange={e => setFilters(f => ({ ...f, from: e.target.value }))}
        />
        <input
          type="date"
          className="input text-sm"
          value={filters.to}
          onChange={e => setFilters(f => ({ ...f, to: e.target.value }))}
        />
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : messages.length === 0 ? (
        <div className="card p-10 text-center text-slate-400">
          <div className="text-3xl mb-2">💬</div>
          <div className="text-sm">No chat messages yet</div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Thread</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Sender</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Message</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Sent</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {messages.map(m => (
                <tr key={m.id} className={m.deleted_at ? 'bg-red-50/40' : 'hover:bg-slate-50'}>
                  <td className="px-4 py-3"><ThreadBadge type={m.thread_type} name={m.thread_name} /></td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{m.sender_name || '—'}</div>
                    <div className="text-xs text-slate-400">{m.sender_email}</div>
                  </td>
                  <td className="px-4 py-3 max-w-md">
                    <div className="text-slate-700 whitespace-pre-wrap break-words">{m.body}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                    {new Date(m.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    {m.deleted_at ? (
                      <span className="text-xs text-red-600 font-medium">
                        Deleted by {m.deleted_by_name || '—'}<br/>
                        <span className="text-slate-400">{new Date(m.deleted_at).toLocaleString()}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-green-600">Active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
