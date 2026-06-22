import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

const STEP_LABELS = {
  policy_resolved:  'Policy in effect',
  global_allowlist: 'Global allowlist (managed bookmarks)',
  lesson_mode:      'Lesson mode',
  penalty_box:      'Penalty box',
  allow_list:       "Policy's allow list",
  deny_list:        "Policy's deny list",
  blocklist:        'Blocklist',
  category:         'Category',
  upstream:         'No block matched',
};

const RESULT_COLOR = {
  blocked: 'text-red-600 font-medium',
  allowed: 'text-green-600 font-medium',
};

const TIER_LABEL_COLOR = {
  lesson:      'text-blue-700',
  penalty_box: 'text-amber-700',
  student:     'text-primary-700',
  group:       'text-primary-700',
  ou:          'text-primary-700',
  default:     'text-slate-500',
  none:        'text-slate-400',
};

// Inner trace rendering, with no table-row wrapper — shared by
// WhyBlockedTrace (below, for table contexts like DnsLogs.jsx/
// BrowserHistoryPage.jsx) and ActiveLesson.jsx's per-student "Test a URL"
// panel (a card grid, not a table). Reuses the same step-by-step trace
// POST /policies/simulate already builds for the filter simulator (kept in
// sync with dns-engine/src/resolver.js's real decision order), plus the
// student's policy precedence chain for context.
export function TraceContent({ studentId, domain }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['why-blocked', studentId || null, domain],
    queryFn:  () => api.post('/policies/simulate', { student_id: studentId || undefined, domain }),
    enabled:  !!domain,
  });

  if (isLoading) return <span className="text-slate-400">Checking decision trace for {domain}…</span>;
  if (error) return <span className="text-red-500">Couldn't trace this: {error.message}</span>;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-slate-500 mb-1.5">
          Decision trace for <span className="font-mono">{domain}</span>
          {!studentId && ' — no student identified, network floor applies to everyone'}:
        </p>
        <ol className="space-y-1">
          {data.trace.map((step, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-4 text-slate-400">{i + 1}.</span>
              <span className="text-slate-700">{STEP_LABELS[step.step] || step.step}</span>
              {step.policy_name && <span className="text-slate-400">({step.policy_name})</span>}
              {step.result && (
                <span className={RESULT_COLOR[step.result] || 'text-slate-400'}>
                  {step.result}
                  {step.matched ? ` — ${step.matched}` : ''}
                  {step.category ? ` — ${step.category}` : ''}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      {data.policy_chain && (
        <div className="border-t border-slate-200 pt-2">
          <p className="text-slate-500 mb-1.5">This student's policy precedence chain:</p>
          <ol className="space-y-1">
            {data.policy_chain.tiers.map(t => {
              const won = t.tier === data.policy_chain.resolved_tier;
              const present = t.active === true || !!t.policy;
              return (
                <li key={t.tier} className={`flex items-center gap-2 ${present ? '' : 'opacity-40'}`}>
                  <span className="w-4">{won ? '→' : ' '}</span>
                  <span className={won ? `${TIER_LABEL_COLOR[t.tier]} font-semibold` : 'text-slate-600'}>
                    {t.policy?.name ? `${t.label}: ${t.policy.name}` : t.label}
                  </span>
                  {!present && <span className="text-slate-400">(none)</span>}
                  {won && <span className="text-xs bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded">resolved</span>}
                </li>
              );
            })}
          </ol>
          {data.policy_chain.note && (
            <p className="text-amber-600 mt-2">{data.policy_chain.note}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Shared by DnsLogs.jsx and BrowserHistoryPage.jsx — expands inline below a
// blocked row to show exactly why.
export default function WhyBlockedTrace({ studentId, domain, colSpan }) {
  return (
    <tr className="bg-slate-50">
      <td colSpan={colSpan} className="px-4 py-3 text-xs">
        <TraceContent studentId={studentId} domain={domain} />
      </td>
    </tr>
  );
}
