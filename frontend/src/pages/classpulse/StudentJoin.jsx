import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../contexts/SocketContext';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Question renderers
// ---------------------------------------------------------------------------

function MultipleChoiceQuestion({ question, onSubmit, submitted }) {
  const [selected, setSelected] = useState(null);

  if (submitted) {
    return (
      <div className="mt-4 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm font-medium text-center">
        Response submitted
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2">
      {question.options.map(opt => (
        <button
          key={opt.id}
          onClick={() => setSelected(opt.id)}
          className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all text-sm font-medium
            ${selected === opt.id
              ? 'border-indigo-500 bg-indigo-50 text-indigo-800'
              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'}`}
        >
          {opt.text}
        </button>
      ))}
      <button
        disabled={!selected}
        onClick={() => onSubmit({ question_id: question.id, response_type: 'choice', option_ids: [selected] })}
        className="mt-2 w-full py-3 rounded-xl bg-indigo-600 text-white font-semibold disabled:opacity-40 hover:bg-indigo-700 transition-colors"
      >
        Submit
      </button>
    </div>
  );
}

function TrueFalseQuestion({ question, onSubmit, submitted }) {
  if (submitted) {
    return (
      <div className="mt-4 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm font-medium text-center">
        Response submitted
      </div>
    );
  }

  const trueOpt  = question.options.find(o => o.text.toLowerCase() === 'true')  || question.options[0];
  const falseOpt = question.options.find(o => o.text.toLowerCase() === 'false') || question.options[1];

  return (
    <div className="mt-4 grid grid-cols-2 gap-3">
      {[trueOpt, falseOpt].filter(Boolean).map(opt => (
        <button
          key={opt.id}
          onClick={() => onSubmit({ question_id: question.id, response_type: 'choice', option_ids: [opt.id] })}
          className={`py-4 rounded-xl border-2 font-bold text-lg transition-all
            ${opt.text.toLowerCase() === 'true'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
              : 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100'}`}
        >
          {opt.text}
        </button>
      ))}
    </div>
  );
}

function ShortAnswerQuestion({ question, onSubmit, submitted }) {
  const [text, setText] = useState('');
  const maxChars = question.settings?.max_chars || 500;

  if (submitted) {
    return (
      <div className="mt-4 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm font-medium text-center">
        Response submitted
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2">
      <textarea
        value={text}
        onChange={e => setText(e.target.value.slice(0, maxChars))}
        rows={4}
        placeholder="Type your answer here…"
        className="w-full rounded-xl border border-slate-200 p-3 text-sm text-slate-800 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
      />
      <div className="flex justify-between items-center">
        <span className="text-xs text-slate-400">{text.length}/{maxChars}</span>
        <button
          disabled={!text.trim()}
          onClick={() => onSubmit({ question_id: question.id, response_type: 'text', text_value: text.trim() })}
          className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-semibold disabled:opacity-40 hover:bg-indigo-700 transition-colors text-sm"
        >
          Submit
        </button>
      </div>
    </div>
  );
}

function ExitTicketQuestion({ question, onSubmit, submitted }) {
  const [rating, setRating] = useState(null);
  const [comment, setComment] = useState('');

  if (submitted) {
    return (
      <div className="mt-4 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm font-medium text-center">
        Response submitted
      </div>
    );
  }

  const levels = [
    { value: 1, label: '😕', title: 'Not yet' },
    { value: 2, label: '🤔', title: 'Getting there' },
    { value: 3, label: '😊', title: 'I think so' },
    { value: 4, label: '🙌', title: 'Got it!' },
  ];

  return (
    <div className="mt-4 space-y-4">
      <div className="flex justify-around">
        {levels.map(l => (
          <button
            key={l.value}
            onClick={() => setRating(l.value)}
            className={`flex flex-col items-center gap-1 p-3 rounded-xl border-2 transition-all w-20
              ${rating === l.value ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'}`}
          >
            <span className="text-2xl">{l.label}</span>
            <span className="text-[10px] text-slate-500 leading-tight text-center">{l.title}</span>
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={e => setComment(e.target.value.slice(0, 300))}
        rows={2}
        placeholder="Any questions or comments? (optional)"
        className="w-full rounded-xl border border-slate-200 p-3 text-sm text-slate-800 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
      />
      <button
        disabled={!rating}
        onClick={() => onSubmit({
          question_id: question.id,
          response_type: 'text',
          text_value: `Rating: ${rating}/4${comment ? ` — ${comment}` : ''}`,
          numeric_value: rating,
        })}
        className="w-full py-3 rounded-xl bg-indigo-600 text-white font-semibold disabled:opacity-40 hover:bg-indigo-700 transition-colors"
      >
        Submit exit ticket
      </button>
    </div>
  );
}

function QuestionRenderer({ question, onSubmit, submitted }) {
  switch (question.question_type) {
    case 'multiple_choice':
      return <MultipleChoiceQuestion question={question} onSubmit={onSubmit} submitted={submitted} />;
    case 'true_false':
      return <TrueFalseQuestion question={question} onSubmit={onSubmit} submitted={submitted} />;
    case 'short_answer':
      return <ShortAnswerQuestion question={question} onSubmit={onSubmit} submitted={submitted} />;
    case 'exit_ticket':
      return <ExitTicketQuestion question={question} onSubmit={onSubmit} submitted={submitted} />;
    default:
      return (
        <ShortAnswerQuestion question={question} onSubmit={onSubmit} submitted={submitted} />
      );
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function StudentJoin() {
  const { code } = useParams();
  const { user, loading: authLoading } = useAuth();
  const { socket } = useSocket();

  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(null);
  const [session,        setSession]        = useState(null);
  const [joined,         setJoined]         = useState(false);
  const [currentPage,    setCurrentPage]    = useState(null);
  const [sessionEnded,   setSessionEnded]   = useState(false);
  const [submitted,      setSubmitted]      = useState({});  // { questionId: true }
  const [helpSending,    setHelpSending]    = useState(false);
  const [helpSent,       setHelpSent]       = useState(false);
  const [submitError,    setSubmitError]    = useState(null);

  const heartbeatRef = useRef(null);

  // Step 1: fetch session info (no auth)
  useEffect(() => {
    if (authLoading) return;

    const BASE = import.meta.env.VITE_API_URL || '';
    fetch(`${BASE}/api/v1/classpulse/join/${code}`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(data => {
        if (data.session?.status !== 'active') {
          setError('This session has ended or is not active.');
          return;
        }
        setSession(data.session);
        if (data.currentPage) setCurrentPage(data.currentPage);
      })
      .catch(e => setError(e.error || 'Session not found.'))
      .finally(() => setLoading(false));
  }, [code, authLoading]);

  // Step 2: join session once session is fetched and user is authenticated
  useEffect(() => {
    if (!session || !user || joined) return;

    api.post(`/classpulse/join/${code}`, {})
      .then(data => {
        setJoined(true);
        // Reload current page from the authoritative endpoint (includes already_responded)
        return api.get(`/classpulse/sessions/${data.session_id}/current`);
      })
      .then(data => {
        if (data.ended) { setSessionEnded(true); return; }
        if (data.page) {
          setCurrentPage(data.page);
          // Pre-mark questions the student already answered
          const preAnswered = {};
          for (const q of data.page.questions || []) {
            if (q.already_responded) preAnswered[q.id] = true;
          }
          setSubmitted(preAnswered);
        }
      })
      .catch(() => {});
  }, [session, user, joined, code]);

  // Step 3: socket room join + heartbeat
  useEffect(() => {
    if (!socket || !joined || !session) return;

    socket.emit('classpulse:join_session', session.id);

    heartbeatRef.current = setInterval(() => {
      socket.emit('classpulse:heartbeat', { sessionId: session.id });
    }, 30_000);

    return () => {
      clearInterval(heartbeatRef.current);
    };
  }, [socket, joined, session]);

  // Step 4: socket event listeners
  useEffect(() => {
    if (!socket || !joined) return;

    const onPageChanged = ({ page }) => {
      setCurrentPage(page);
      // Reset submission state for the new page's questions
      setSubmitted({});
      setHelpSent(false);
      // Fetch fresh to get already_responded per student
      if (session) {
        api.get(`/classpulse/sessions/${session.id}/current`)
          .then(data => {
            if (data.ended) { setSessionEnded(true); return; }
            if (data.page) {
              setCurrentPage(data.page);
              const pre = {};
              for (const q of data.page.questions || []) {
                if (q.already_responded) pre[q.id] = true;
              }
              setSubmitted(pre);
            }
          })
          .catch(() => {});
      }
    };

    const onSessionEnded = () => setSessionEnded(true);

    socket.on('classpulse:page_changed', onPageChanged);
    socket.on('classpulse:session_ended', onSessionEnded);

    return () => {
      socket.off('classpulse:page_changed', onPageChanged);
      socket.off('classpulse:session_ended', onSessionEnded);
    };
  }, [socket, joined, session]);

  const submitResponse = useCallback(async (payload) => {
    if (!session) return;
    setSubmitError(null);
    try {
      await api.post(`/classpulse/sessions/${session.id}/response`, payload);
      setSubmitted(prev => ({ ...prev, [payload.question_id]: true }));
    } catch (e) {
      setSubmitError(e.message || 'Failed to submit. Try again.');
    }
  }, [session]);

  const sendHelp = useCallback(() => {
    if (!socket || !session || helpSent) return;
    setHelpSending(true);
    socket.emit('classpulse:help_request', { sessionId: session.id });
    setTimeout(() => {
      setHelpSending(false);
      setHelpSent(true);
    }, 500);
  }, [socket, session, helpSent]);

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-400 text-sm">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-sm w-full text-center">
          <div className="text-4xl mb-3">❌</div>
          <h1 className="text-lg font-bold text-slate-800 mb-2">Session not found</h1>
          <p className="text-sm text-slate-500">{error}</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-sm w-full text-center">
          <div className="text-4xl mb-3">🔒</div>
          <h1 className="text-lg font-bold text-slate-800 mb-2">Sign in required</h1>
          <p className="text-sm text-slate-500 mb-4">
            You need to be signed in to join this session. Make sure your ClassGuard extension is active.
          </p>
          {session && (
            <div className="bg-indigo-50 rounded-xl p-3 text-sm text-indigo-700">
              <span className="font-semibold">{session.lesson_title || 'Untitled Lesson'}</span>
              {session.class_name ? ` — ${session.class_name}` : ''}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (sessionEnded) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-sm w-full text-center">
          <div className="text-4xl mb-3">✅</div>
          <h1 className="text-lg font-bold text-slate-800 mb-2">Session ended</h1>
          <p className="text-sm text-slate-500">Your teacher has ended the session. Great work!</p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main session view
  // ---------------------------------------------------------------------------

  const questions = currentPage?.questions || [];

  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs text-slate-400 font-medium truncate">
              {session.class_name || 'ClassPulse'}
            </p>
            <p className="text-sm font-semibold text-slate-700 truncate">
              {session.lesson_title || 'Live Session'}
            </p>
          </div>
          <div className="flex items-center gap-2 ml-3 flex-shrink-0">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 py-6 space-y-4">
        {/* Waiting state */}
        {!currentPage && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center">
            <div className="text-3xl mb-3">⏳</div>
            <h2 className="text-base font-semibold text-slate-700 mb-1">Waiting for teacher…</h2>
            <p className="text-sm text-slate-400">Your teacher will start the first slide shortly.</p>
          </div>
        )}

        {/* Content slide */}
        {currentPage && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            {currentPage.title && (
              <div className="bg-indigo-600 px-5 py-4">
                <p className="text-xs text-indigo-200 font-medium mb-0.5">
                  Slide {currentPage.position}
                </p>
                <h2 className="text-white font-bold text-lg leading-snug">
                  {currentPage.title}
                </h2>
              </div>
            )}

            {currentPage.body && (
              <div className="px-5 py-4">
                <p className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">
                  {currentPage.body}
                </p>
              </div>
            )}

            {currentPage.student_instructions && (
              <div className="mx-5 mb-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
                <p className="text-xs font-semibold text-amber-700 mb-1">Instructions</p>
                <p className="text-sm text-amber-800 leading-relaxed">
                  {currentPage.student_instructions}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Questions */}
        {questions.map(question => (
          <div key={question.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 px-5 py-5">
            <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-2">
              {question.question_type === 'exit_ticket' ? 'Exit Ticket' :
               question.question_type === 'true_false'  ? 'True or False' :
               question.question_type === 'short_answer' ? 'Short Answer' :
               'Question'}
            </p>
            <p className="text-slate-800 font-semibold text-base leading-snug">
              {question.prompt}
            </p>
            <QuestionRenderer
              question={question}
              onSubmit={submitResponse}
              submitted={!!submitted[question.id]}
            />
          </div>
        ))}

        {submitError && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
            {submitError}
          </div>
        )}

        {/* Help request */}
        {joined && (
          <div className="text-center">
            <button
              onClick={sendHelp}
              disabled={helpSent || helpSending}
              className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 disabled:opacity-50 transition-colors"
            >
              <span>🤚</span>
              {helpSent ? 'Help request sent!' : helpSending ? 'Sending…' : 'Raise hand for help'}
            </button>
          </div>
        )}

        {/* Join code display */}
        <div className="text-center pb-4">
          <p className="text-xs text-slate-300">
            Session code: <span className="font-mono tracking-widest">{code?.toUpperCase()}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
