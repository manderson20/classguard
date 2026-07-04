import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSocket } from '../../contexts/SocketContext';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Pulse Score Gauge (SVG arc, no library needed)
// ---------------------------------------------------------------------------
const GAUGE_CX = 100, GAUGE_CY = 105, GAUGE_R = 72;
const GAUGE_START = 135, GAUGE_SWEEP = 270;

function polarXY(cx, cy, r, deg) {
  const rad = (deg - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, fromDeg, toDeg) {
  const s = polarXY(cx, cy, r, fromDeg);
  const e = polarXY(cx, cy, r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

function scoreColor(score) {
  if (score >= 80) return '#10b981'; // emerald
  if (score >= 60) return '#f59e0b'; // amber
  if (score >= 40) return '#f97316'; // orange
  return '#ef4444';                  // red
}

function scoreLabel(score) {
  if (score >= 80) return 'Class is Engaged';
  if (score >= 60) return 'Some Confusion';
  if (score >= 40) return 'Losing Momentum';
  return 'Needs Attention';
}

function PulseGauge({ score, participation, comprehension, focus }) {
  const endDeg = GAUGE_START + Math.max(1, (score / 100) * GAUGE_SWEEP);
  const bgEnd  = GAUGE_START + GAUGE_SWEEP;
  const color  = scoreColor(score);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 140" className="w-44">
        {/* Background arc */}
        <path
          d={arcPath(GAUGE_CX, GAUGE_CY, GAUGE_R, GAUGE_START, bgEnd)}
          fill="none" stroke="#e2e8f0" strokeWidth="14" strokeLinecap="round"
        />
        {/* Score arc */}
        <path
          d={arcPath(GAUGE_CX, GAUGE_CY, GAUGE_R, GAUGE_START, endDeg)}
          fill="none" stroke={color} strokeWidth="14" strokeLinecap="round"
          style={{ transition: 'all 0.6s ease' }}
        />
        {/* Score text */}
        <text x={GAUGE_CX} y={GAUGE_CY + 8} textAnchor="middle"
          fontSize="30" fontWeight="700" fill={color}>
          {score}
        </text>
        <text x={GAUGE_CX} y={GAUGE_CY + 26} textAnchor="middle"
          fontSize="9" fill="#94a3b8">
          {scoreLabel(score)}
        </text>
      </svg>
      {/* Sub-scores */}
      <div className="flex gap-4 text-center mt-1">
        {[
          { label: 'Part.', value: participation },
          { label: 'Comp.', value: comprehension },
          { label: 'Focus', value: focus },
        ].map(s => (
          <div key={s.label}>
            <p className="text-[11px] font-bold text-slate-700">{s.value}%</p>
            <p className="text-[9px] text-slate-400">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MC bar chart
// ---------------------------------------------------------------------------
function McBarChart({ options, totalResponses }) {
  const max = Math.max(...options.map(o => o.count), 1);
  return (
    <div className="space-y-2 mt-2">
      {options.map(opt => {
        return (
          <div key={opt.id}>
            <div className="flex items-center justify-between mb-0.5">
              <span className={`text-xs font-medium truncate flex-1 mr-2 ${opt.is_correct ? 'text-emerald-700' : 'text-slate-600'}`}>
                {opt.is_correct && <span className="mr-1">✓</span>}
                {opt.text}
              </span>
              <span className="text-xs text-slate-400 flex-shrink-0">{opt.count}</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${opt.is_correct ? 'bg-emerald-400' : 'bg-indigo-400'}`}
                style={{ width: `${(opt.count / max) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Response feed (short answer / exit ticket)
// ---------------------------------------------------------------------------
function ResponseFeed({ responses, onFlag, onHide }) {
  return (
    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
      {responses.length === 0 && (
        <p className="text-xs text-slate-400 text-center py-4">No responses yet</p>
      )}
      {responses.map((r, i) => (
        <div key={r.id || i} className={`text-xs p-2.5 rounded-lg border group relative
          ${r.is_flagged ? 'border-amber-300 bg-amber-50' : 'border-slate-100 bg-slate-50'}`}>
          <div className="flex items-start justify-between gap-2">
            <span className="text-slate-400 flex-shrink-0 font-mono">#{r.anonymousOrder}</span>
            <p className="text-slate-700 flex-1 leading-relaxed">{r.text_value}</p>
            <div className="hidden group-hover:flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => onFlag(r)}
                className={`text-[10px] px-1.5 py-0.5 rounded ${r.is_flagged ? 'text-amber-600 hover:text-amber-800' : 'text-slate-400 hover:text-amber-600'}`}
                title={r.is_flagged ? 'Unflag' : 'Flag'}
              >
                {r.is_flagged ? '⚑' : '⚐'}
              </button>
              <button
                onClick={() => onHide(r)}
                className="text-[10px] text-slate-400 hover:text-rose-500 px-1.5 py-0.5 rounded"
                title="Hide from class display"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Question aggregate panel
// ---------------------------------------------------------------------------
function QuestionPanel({ agg, liveResponses, joinedCount }) {
  const { question, responses: restResponses, aggregate } = agg;

  // Merge REST responses with any live socket responses that arrived since the last poll.
  // Socket payloads use camelCase (studentId/textValue) while REST rows use
  // snake_case — normalize the live rows so the feed below can render either.
  const allLive = liveResponses[question.id] || [];
  const knownStudentIds = new Set(restResponses.map(r => r.student_id));
  const newLive = allLive
    .filter(r => !knownStudentIds.has(r.studentId))
    .map((r, i) => ({
      ...r,
      student_id:     r.studentId,
      text_value:     r.textValue,
      option_ids:     r.optionIds,
      anonymousOrder: restResponses.length + i + 1,
    }));
  const merged   = [...restResponses, ...newLive];
  const total    = merged.length;

  // For MC: merge tally with live socket option hits
  let displayOptions = aggregate?.options || [];
  if (aggregate?.type === 'tally' && newLive.length > 0) {
    const liveTally = {};
    for (const r of newLive) {
      for (const oid of (r.optionIds || [])) {
        liveTally[oid] = (liveTally[oid] || 0) + 1;
      }
    }
    displayOptions = displayOptions.map(o => ({
      ...o,
      count: o.count + (liveTally[o.id] || 0),
    }));
  }

  const [flagging, setFlagging] = useState({});
  const [hiding,   setHiding]   = useState({});

  const handleFlag = useCallback(async (resp) => {
    if (flagging[resp.id]) return;
    setFlagging(f => ({ ...f, [resp.id]: true }));
    try {
      if (resp.is_flagged) await api.delete(`/classpulse/responses/${resp.id}/flag`);
      else                 await api.post(`/classpulse/responses/${resp.id}/flag`, {});
      // Optimistically toggle — full state refreshed on next poll
    } catch {}
    setFlagging(f => ({ ...f, [resp.id]: false }));
  }, [flagging]);

  const handleHide = useCallback(async (resp) => {
    if (hiding[resp.id]) return;
    setHiding(h => ({ ...h, [resp.id]: true }));
    try {
      await api.post(`/classpulse/responses/${resp.id}/hide`, {});
    } catch {}
    setHiding(h => ({ ...h, [resp.id]: false }));
  }, [hiding]);

  return (
    <div className="border border-slate-200 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-[10px] font-semibold text-indigo-500 uppercase tracking-wide">
            {question.type === 'multiple_choice' ? 'Multiple Choice' :
             question.type === 'true_false'      ? 'True / False'    :
             question.type === 'exit_ticket'     ? 'Exit Ticket'     : 'Short Answer'}
          </span>
          <p className="text-sm font-semibold text-slate-800 mt-0.5 leading-snug">{question.prompt}</p>
        </div>
        <span className="text-xs font-bold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5 flex-shrink-0">
          {total}{joinedCount > 0 ? `/${joinedCount}` : ''}{' '}
          <span className="font-normal text-slate-400">responded</span>
        </span>
      </div>

      {(aggregate?.type === 'tally') && (
        <McBarChart options={displayOptions} totalResponses={total} />
      )}

      {(aggregate?.type === 'list') && (
        <ResponseFeed responses={merged} onFlag={handleFlag} onHide={handleHide} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function timeSince(ts, now) {
  const diff = Math.round((now - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  return `${Math.round(diff / 60)}m ago`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function TeachSession() {
  const { id: sessionId } = useParams();
  const navigate          = useNavigate();
  const { socket }        = useSocket();

  const [dashboard,     setDashboard]     = useState(null);
  const [pulseScore,    setPulseScore]    = useState(null);
  const [liveResponses, setLiveResponses] = useState({});  // { questionId: [response, ...] }
  const [helpRequests,  setHelpRequests]  = useState([]);
  const [offTaskAlerts, setOffTask]       = useState([]);
  const [liveJoined,    setLiveJoined]    = useState([]);   // names that joined via socket
  const [locked,        setLocked]        = useState(false);
  const [sessionEnded,  setSessionEnded]  = useState(false);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState(null);
  const [navigating,    setNavigating]    = useState(false);
  const [ending,        setEnding]        = useState(false);
  const [locking,       setLocking]       = useState(false);
  const [now,           setNow]           = useState(Date.now());

  const pollRef = useRef(null);

  // Relative-time ticker for "X ago" labels
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // Fetch full dashboard state (also used for periodic refresh)
  const fetchDashboard = useCallback(async () => {
    try {
      const data = await api.get(`/classpulse/sessions/${sessionId}/dashboard`);
      setDashboard(data);
      setPulseScore(data.pulseScore);
      setLocked(data.session?.classroom_lock_enabled || false);
      if (data.session?.status === 'ended') setSessionEnded(true);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load session');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Initial load + polling every 30 s
  useEffect(() => {
    fetchDashboard();
    pollRef.current = setInterval(fetchDashboard, 30_000);
    return () => clearInterval(pollRef.current);
  }, [fetchDashboard]);

  // Socket: join dashboard room + event listeners
  useEffect(() => {
    if (!socket || !sessionId) return;

    socket.emit('classpulse:join_dashboard', sessionId);

    const onResponse = (payload) => {
      setLiveResponses(prev => {
        const existing = prev[payload.questionId] || [];
        // Deduplicate by studentId (last response wins — backend upserts)
        const filtered = existing.filter(r => r.studentId !== payload.studentId);
        return {
          ...prev,
          [payload.questionId]: [...filtered, payload],
        };
      });
    };

    const onPulseScore = (score) => setPulseScore(score);

    const onStudentJoined = ({ studentId, studentName, ts }) => {
      setLiveJoined(prev => {
        if (prev.some(s => s.studentId === studentId)) return prev;
        return [...prev, { studentId, studentName, ts }];
      });
      // The presence list and "N joined" header both come from the REST
      // dashboard — without this refetch a join wouldn't show for up to 30 s,
      // exactly while the teacher is watching the class file in.
      fetchDashboard();
    };

    const onHelpRequest = (payload) => {
      setHelpRequests(prev => [{ ...payload, ts: payload.ts || Date.now() }, ...prev].slice(0, 20));
    };

    const onOffTask = (payload) => {
      setOffTask(prev => [{ ...payload, ts: Date.now() }, ...prev].slice(0, 20));
    };

    const onPageChanged = () => {
      // Clear live responses for the new page; re-fetch dashboard
      setLiveResponses({});
      fetchDashboard();
    };

    const onLockChanged = ({ locked: l }) => setLocked(l);
    const onSessionEnded = () => setSessionEnded(true);

    socket.on('classpulse:response',       onResponse);
    socket.on('classpulse:pulse_score',    onPulseScore);
    socket.on('classpulse:student_joined', onStudentJoined);
    socket.on('classpulse:help_request',   onHelpRequest);
    socket.on('classpulse:off_task_alert', onOffTask);
    socket.on('classpulse:page_changed',   onPageChanged);
    socket.on('classpulse:lock_changed',   onLockChanged);
    socket.on('classpulse:session_ended',  onSessionEnded);

    return () => {
      socket.off('classpulse:response',       onResponse);
      socket.off('classpulse:pulse_score',    onPulseScore);
      socket.off('classpulse:student_joined', onStudentJoined);
      socket.off('classpulse:help_request',   onHelpRequest);
      socket.off('classpulse:off_task_alert', onOffTask);
      socket.off('classpulse:page_changed',   onPageChanged);
      socket.off('classpulse:lock_changed',   onLockChanged);
      socket.off('classpulse:session_ended',  onSessionEnded);
      socket.emit('classpulse:leave_dashboard', sessionId);
    };
  }, [socket, sessionId, fetchDashboard]);

  const navigate_ = useCallback(async (dir) => {
    if (navigating) return;
    setNavigating(true);
    try {
      await api.post(`/classpulse/sessions/${sessionId}/${dir}`, {});
      setLiveResponses({});
      await fetchDashboard();
    } catch {}
    setNavigating(false);
  }, [navigating, sessionId, fetchDashboard]);

  const toggleLock = useCallback(async () => {
    setLocking(true);
    try {
      if (locked) await api.post(`/classpulse/sessions/${sessionId}/unlock`, {});
      else        await api.post(`/classpulse/sessions/${sessionId}/lock`, {});
      setLocked(l => !l);
    } catch {}
    setLocking(false);
  }, [locked, sessionId]);

  const endSession = useCallback(async () => {
    if (!window.confirm('End this session? Students will be notified.')) return;
    setEnding(true);
    try {
      await api.post(`/classpulse/sessions/${sessionId}/end`, {});
      setSessionEnded(true);
    } catch {
      setEnding(false);
    }
  }, [sessionId]);

  const dismissHelp = (idx) =>
    setHelpRequests(prev => prev.filter((_, i) => i !== idx));

  const dismissOffTask = (idx) =>
    setOffTask(prev => prev.filter((_, i) => i !== idx));

  // ---------------------------------------------------------------------------
  // Loading / error / ended states
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="text-slate-400 text-sm">Loading session…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="text-center">
          <p className="text-rose-600 font-medium mb-3">{error}</p>
          <button onClick={() => navigate('/classpulse')} className="btn btn-secondary text-sm">
            Back to ClassPulse
          </button>
        </div>
      </div>
    );
  }

  if (sessionEnded) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="bg-white rounded-2xl shadow-lg p-10 max-w-sm w-full text-center">
          <div className="text-4xl mb-3">✅</div>
          <h1 className="text-xl font-bold text-slate-800 mb-2">Session ended</h1>
          {pulseScore && (
            <p className="text-sm text-slate-500 mb-1">
              Final Pulse Score: <span className="font-bold" style={{ color: scoreColor(pulseScore.score) }}>{pulseScore.score}</span>
            </p>
          )}
          <p className="text-sm text-slate-400 mb-6">Students have been notified.</p>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => navigate(`/classpulse/sessions/${sessionId}/results`)}
              className="btn btn-primary w-full text-sm"
            >
              View results
            </button>
            <div className="flex gap-3">
              <button onClick={() => navigate('/classpulse/lessons')} className="btn btn-secondary flex-1 text-sm">
                Lesson Library
              </button>
              <button onClick={() => navigate('/classpulse')} className="btn btn-secondary flex-1 text-sm">
                ClassPulse Hub
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Derive display values
  // ---------------------------------------------------------------------------
  const { session, students, pages, questionAggregates } = dashboard || {};
  const pulse = pulseScore || { score: 0, participation: 0, comprehension: 0, focus: 100 };

  const currentPageIdx = pages?.findIndex(p => p.id === session?.current_page_id) ?? -1;
  const currentPage    = pages?.[currentPageIdx] ?? null;
  const atStart        = currentPageIdx <= 0;
  const atEnd          = currentPageIdx >= (pages?.length ?? 0) - 1;

  const PRESENCE_TIMEOUT_MS = 90_000;
  const activeStudents     = students?.filter(s => now - new Date(s.last_seen_at).getTime() < PRESENCE_TIMEOUT_MS) ?? [];
  const disconnectedStudents = students?.filter(s => now - new Date(s.last_seen_at).getTime() >= PRESENCE_TIMEOUT_MS) ?? [];
  const studentCount       = activeStudents.length;

  const joinCode = session?.join_code?.toUpperCase() ?? '';

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-100">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-4 flex-shrink-0">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold text-slate-800 truncate leading-tight">
            {session?.lesson_title || 'Live Session'}
          </h1>
          <p className="text-xs text-slate-400 leading-none mt-0.5">
            {session?.class_name || 'Open session'}
          </p>
        </div>

        {/* Join code */}
        <div className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-1.5 flex-shrink-0">
          <span className="text-[10px] text-indigo-400 font-semibold uppercase">Join</span>
          <span className="font-mono font-bold text-indigo-700 tracking-widest text-sm">{joinCode}</span>
        </div>

        {/* Live indicator */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs font-medium text-emerald-600">{studentCount} joined</span>
        </div>

        {/* Lock toggle */}
        <button
          onClick={toggleLock}
          disabled={locking}
          className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors flex-shrink-0
            ${locked
              ? 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
              : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'}`}
        >
          {locked ? '🔒 Locked' : '🔓 Unlocked'}
        </button>

        {/* End session */}
        <button
          onClick={endSession}
          disabled={ending}
          className="btn btn-danger text-xs py-1.5 px-4 flex-shrink-0"
        >
          {ending ? 'Ending…' : 'End Session'}
        </button>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left panel */}
        <aside className="w-56 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">

            {/* Pulse gauge — neutral placeholder until someone joins, so the
                teacher isn't greeted by an alarming red 0 on an empty room */}
            <div className="px-3 py-4 flex flex-col items-center">
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-2">Pulse Score</p>
              {studentCount === 0 || (currentPage && questionAggregates?.length === 0) ? (
                <div className="w-44 h-32 flex flex-col items-center justify-center text-center">
                  <span className="text-3xl font-bold text-slate-300">—</span>
                  <span className="text-[10px] text-slate-400 mt-1">
                    {studentCount === 0
                      ? 'Waiting for students to join'
                      : 'No question on this slide'}
                  </span>
                </div>
              ) : (
                <PulseGauge
                  score={pulse.score}
                  participation={pulse.participation}
                  comprehension={pulse.comprehension}
                  focus={pulse.focus}
                />
              )}
            </div>

            {/* Students */}
            <div className="px-3 py-3">
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
                Students ({studentCount} active{disconnectedStudents.length > 0 ? `, ${disconnectedStudents.length} away` : ''})
              </p>
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {activeStudents.length === 0 && liveJoined.length === 0 && (
                  <p className="text-[11px] text-slate-400 italic">Waiting for students…</p>
                )}
                {activeStudents.map(s => (
                  <div key={s.student_id} className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                    <span className="text-[11px] text-slate-700 truncate">{s.full_name || s.email}</span>
                  </div>
                ))}
                {disconnectedStudents.map(s => (
                  <div key={s.student_id} className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 flex-shrink-0" />
                    <span className="text-[11px] text-slate-400 truncate">{s.full_name || s.email}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Help requests */}
            {helpRequests.length > 0 && (
              <div className="px-3 py-3">
                <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-widest mb-2">
                  🤚 Help Requests ({helpRequests.length})
                </p>
                <div className="space-y-1.5">
                  {helpRequests.map((h, i) => (
                    <div key={i} className="bg-amber-50 rounded-lg px-2 py-1.5 flex items-start justify-between gap-1">
                      <div>
                        <p className="text-[11px] font-semibold text-amber-800">{h.studentName}</p>
                        {h.message && (
                          <p className="text-[10px] text-amber-600 mt-0.5 line-clamp-2">{h.message}</p>
                        )}
                        <p className="text-[9px] text-amber-400 mt-0.5">{timeSince(h.ts, now)}</p>
                      </div>
                      <button onClick={() => dismissHelp(i)} className="text-amber-400 hover:text-amber-600 text-xs flex-shrink-0">✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Off-task alerts */}
            {offTaskAlerts.length > 0 && (
              <div className="px-3 py-3">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
                  Off-task ({offTaskAlerts.length})
                </p>
                <div className="space-y-1.5">
                  {offTaskAlerts.map((a, i) => {
                    const alertStudent = students?.find(s => s.student_id === a.studentId);
                    return (
                    <div key={i} className="bg-rose-50 rounded-lg px-2 py-1.5 flex items-start justify-between gap-1">
                      <div>
                        <p className="text-[11px] font-semibold text-rose-700">{alertStudent?.full_name || alertStudent?.email || 'Unknown'}</p>
                        {a.title && <p className="text-[10px] text-rose-500 mt-0.5 truncate">{a.title}</p>}
                        <p className="text-[9px] text-rose-300 mt-0.5">{timeSince(a.ts, now)}</p>
                      </div>
                      <button onClick={() => dismissOffTask(i)} className="text-rose-300 hover:text-rose-500 text-xs flex-shrink-0">✕</button>
                    </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* No page yet */}
          {!currentPage && (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center">
              <p className="text-slate-400 text-sm">No slide selected. Use the navigation below to start.</p>
            </div>
          )}

          {/* Current slide */}
          {currentPage && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="bg-indigo-600 px-5 py-4">
                <p className="text-xs text-indigo-200 font-medium">
                  Slide {currentPageIdx + 1} of {pages?.length ?? 0}
                  {currentPage.content_type && currentPage.content_type !== 'content' && (
                    <span className="ml-2 capitalize bg-indigo-500 rounded px-1.5 py-0.5">
                      {currentPage.content_type === 'exit_ticket' ? 'Exit Ticket' : 'Question'}
                    </span>
                  )}
                </p>
                {currentPage.title && (
                  <h2 className="text-white font-bold text-lg leading-snug mt-0.5">{currentPage.title}</h2>
                )}
              </div>

              {/* Slide body — what the students are reading right now */}
              {currentPage.body && (
                <div className="px-5 py-4">
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{currentPage.body}</p>
                </div>
              )}
              {!currentPage.body && questionAggregates?.length === 0 && (
                <div className="px-5 py-4">
                  <p className="text-sm text-slate-400 italic">Content slide — no questions on this page.</p>
                </div>
              )}
              {/* Teacher notes — never shown to students */}
              {currentPage.teacher_notes && (
                <div className="mx-5 mb-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
                  <p className="text-xs font-semibold text-amber-700 mb-1">Teacher notes (private)</p>
                  <p className="text-sm text-amber-800 leading-relaxed whitespace-pre-wrap">{currentPage.teacher_notes}</p>
                </div>
              )}
            </div>
          )}

          {/* Question aggregates */}
          {questionAggregates?.map(agg => (
            agg && (
              <QuestionPanel
                key={agg.question.id}
                agg={agg}
                liveResponses={liveResponses}
                joinedCount={studentCount}
              />
            )
          ))}

          {/* Empty aggregate state — count live socket responses too, or this
              keeps saying "waiting" while answers stream in between polls */}
          {currentPage && questionAggregates?.length > 0 &&
            questionAggregates.every(a => a && a.total_responses === 0 && !(liveResponses[a.question.id]?.length)) && (
            <div className="text-center text-xs text-slate-400 py-2">
              Waiting for student responses…
            </div>
          )}
        </main>
      </div>

      {/* ── Navigation footer ────────────────────────────────────────────── */}
      <footer className="bg-white border-t border-slate-200 px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={() => navigate_('previous')}
          disabled={navigating || atStart}
          className="btn btn-secondary text-sm px-4 disabled:opacity-40"
        >
          ← Prev
        </button>

        <div className="flex-1 text-center">
          {currentPage ? (
            <div className="flex items-center justify-center gap-2">
              {pages?.map((p, idx) => (
                <button
                  key={p.id}
                  onClick={async () => {
                    if (p.id === session?.current_page_id || navigating) return;
                    setNavigating(true);
                    try {
                      await api.post(`/classpulse/sessions/${sessionId}/goto`, { page_id: p.id });
                      setLiveResponses({});
                      await fetchDashboard();
                    } catch {}
                    setNavigating(false);
                  }}
                  title={p.title || `Slide ${idx + 1}`}
                  className={`w-2.5 h-2.5 rounded-full transition-all ${
                    p.id === session?.current_page_id
                      ? 'bg-indigo-600 scale-125'
                      : 'bg-slate-300 hover:bg-slate-400'
                  }`}
                />
              ))}
            </div>
          ) : (
            <span className="text-xs text-slate-400">
              {pages?.length ? `${pages.length} slide${pages.length !== 1 ? 's' : ''} in this lesson` : ''}
            </span>
          )}
        </div>

        <button
          onClick={() => navigate_('next')}
          disabled={navigating || atEnd}
          className="btn btn-primary text-sm px-4 disabled:opacity-40"
        >
          Next →
        </button>
      </footer>
    </div>
  );
}
