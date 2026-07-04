import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../contexts/SocketContext';
import api from '../../lib/api';
import { QuestionRenderer } from '../../components/classpulse/QuestionRenderers';

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function StudentJoin() {
  const { code } = useParams();
  const { user, loading: authLoading, login } = useAuth();
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

  // Step 0: silent sign-in via the ClassGuard extension. On a managed device
  // the extension already holds the student's JWT — ask its content script
  // for it (the service worker only answers this exact page on the
  // configured server origin), so students never see a sign-in prompt. On
  // devices without the extension nothing replies and the normal
  // sign-in card below still applies.
  useEffect(() => {
    if (authLoading || user) return;
    const onAuth = (e) => {
      if (e.source !== window || e.origin !== window.location.origin) return;
      if (e.data?.source !== 'classguard-extension' || e.data?.type !== 'classguard:pulse-auth') return;
      if (e.data.token) login(e.data.token).catch(() => {});
    };
    window.addEventListener('message', onAuth);
    window.dispatchEvent(new CustomEvent('classguard:request-pulse-auth'));
    return () => window.removeEventListener('message', onAuth);
  }, [authLoading, user, login]);

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
          <h1 className="text-lg font-bold text-slate-800 mb-2">Sign in to join</h1>
          <p className="text-sm text-slate-500 mb-4">
            Sign in with your school account so your answers are recorded under your name.
          </p>
          {session && (
            <div className="bg-indigo-50 rounded-xl p-3 text-sm text-indigo-700 mb-4">
              <span className="font-semibold">{session.lesson_title || 'Untitled Lesson'}</span>
              {session.class_name ? ` — ${session.class_name}` : ''}
            </div>
          )}
          <a
            href={`/login?next=${encodeURIComponent(`/pulse/${code}`)}`}
            className="block w-full py-3 rounded-xl bg-indigo-600 text-white font-semibold hover:bg-indigo-700 transition-colors"
          >
            Sign in
          </a>
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
