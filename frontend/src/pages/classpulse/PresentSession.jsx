import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSocket } from '../../contexts/SocketContext';
import api from '../../lib/api';
import AuthedImage from '../../components/AuthedImage';

// Projector view ("Show to Class") — a clean, anonymous, full-screen results
// display the teacher puts on the board while students answer on their own
// devices. Mentimeter-style: big join code, the current slide/question, and
// live aggregates (bars for choices, a word cloud for free text). Never shows
// names; flagged and hidden responses are excluded.

// Small English stopword list for the word cloud — enough to keep "the/and"
// from dominating without pretending to be NLP.
const STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','been','to','of',
  'in','on','at','for','with','it','its','this','that','these','those','i','we',
  'you','they','he','she','my','our','your','their','me','us','them','so','as',
  'if','then','than','not','no','yes','do','does','did','have','has','had','can',
  'will','would','just','very','really','about','into','out','up','down','also',
]);

function buildWordCloud(texts, maxWords = 30) {
  const counts = new Map();
  for (const t of texts) {
    for (const raw of String(t || '').toLowerCase().split(/[^a-z0-9']+/)) {
      const w = raw.replace(/^'+|'+$/g, '');
      if (w.length < 3 || STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxWords);
}

function WordCloud({ texts }) {
  const words = useMemo(() => buildWordCloud(texts), [texts]);
  if (!words.length) return null;
  const max = words[0][1];
  // Deterministic pseudo-shuffle so the layout is stable between re-renders
  const display = [...words].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div className="flex flex-wrap items-baseline justify-center gap-x-5 gap-y-2 py-4">
      {display.map(([word, count]) => {
        const scale = 0.9 + (count / max) * 2.2; // 0.9rem → 3.1rem
        const emphasis = count / max;
        return (
          <span
            key={word}
            style={{ fontSize: `${scale}rem`, opacity: 0.45 + emphasis * 0.55 }}
            className={`font-bold leading-none ${emphasis > 0.66 ? 'text-indigo-600' : emphasis > 0.33 ? 'text-indigo-500' : 'text-slate-500'}`}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
}

function BigBars({ options, total }) {
  const max = Math.max(...options.map(o => o.count), 1);
  return (
    <div className="space-y-4">
      {options.map(o => (
        <div key={o.id}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xl font-semibold text-slate-700">{o.text}</span>
            <span className="text-lg text-slate-400 font-mono">
              {o.count}{total > 0 ? ` · ${Math.round((o.count / total) * 100)}%` : ''}
            </span>
          </div>
          <div className="h-6 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-700"
              style={{ width: `${(o.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PresentSession() {
  const { id: sessionId } = useParams();
  const { socket } = useSocket();
  const [liveResponses, setLiveResponses] = useState({}); // { questionId: [payload] }

  const { data: dashboard, refetch } = useQuery({
    queryKey: ['classpulse-present', sessionId],
    queryFn:  () => api.get(`/classpulse/sessions/${sessionId}/dashboard`),
    refetchInterval: 10_000, // poll fallback — socket is the fast path
    staleTime: 0,
  });

  const onPageChanged = useCallback(() => {
    setLiveResponses({});
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!socket || !sessionId) return;
    socket.emit('classpulse:join_dashboard', sessionId);

    const onResponse = (payload) => {
      setLiveResponses(prev => {
        const existing = (prev[payload.questionId] || []).filter(r => r.studentId !== payload.studentId);
        return { ...prev, [payload.questionId]: [...existing, payload] };
      });
    };

    socket.on('classpulse:response', onResponse);
    socket.on('classpulse:page_changed', onPageChanged);
    return () => {
      socket.off('classpulse:response', onResponse);
      socket.off('classpulse:page_changed', onPageChanged);
      socket.emit('classpulse:leave_dashboard', sessionId);
    };
  }, [socket, sessionId, onPageChanged]);

  const { session, students, pages, questionAggregates } = dashboard || {};
  const currentPage = pages?.find(p => p.id === session?.current_page_id) || null;
  const joinCode = session?.join_code?.toUpperCase() ?? '';
  const joinedCount = students?.length ?? 0;

  if (dashboard && session?.status === 'ended') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <p className="text-3xl font-bold text-slate-300">Session ended</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header — the join code is the star; students need to read it from
          the back row */}
      <header className="bg-indigo-600 text-white px-8 py-4 flex items-center justify-between flex-shrink-0">
        <div className="min-w-0">
          <p className="text-indigo-200 text-sm">{session?.class_name || 'ClassPulse'}</p>
          <h1 className="text-xl font-bold truncate">{session?.lesson_title || 'Live Session'}</h1>
        </div>
        <div className="flex items-center gap-6 flex-shrink-0">
          <div className="text-right">
            <p className="text-indigo-200 text-xs uppercase tracking-widest">Join at {window.location.host}/pulse</p>
            <p className="font-mono font-black text-4xl tracking-[0.3em]">{joinCode}</p>
          </div>
          <div className="text-center bg-indigo-500/60 rounded-xl px-4 py-2">
            <p className="text-3xl font-bold leading-none">{joinedCount}</p>
            <p className="text-[10px] text-indigo-200 uppercase tracking-wide mt-1">joined</p>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-8 py-6 max-w-5xl mx-auto w-full space-y-6">
        {!currentPage && (
          <div className="text-center py-24 text-slate-400 text-2xl">Waiting for the first slide…</div>
        )}

        {currentPage && (
          <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
            {currentPage.title && (
              <div className="px-8 pt-6">
                <h2 className="text-3xl font-bold text-slate-800">{currentPage.title}</h2>
              </div>
            )}
            {currentPage.image_url && (
              <AuthedImage
                src={`/api/v1/classpulse/slide-image/${currentPage.id}`}
                alt={currentPage.title || 'Slide'}
                className="w-full max-h-[52vh] object-contain mt-4"
              />
            )}
            {currentPage.body && (
              <p className="px-8 py-5 text-xl text-slate-700 leading-relaxed whitespace-pre-wrap">{currentPage.body}</p>
            )}
            {!currentPage.body && !currentPage.image_url && !questionAggregates?.length && (
              <p className="px-8 py-6 text-slate-400 italic">Content slide</p>
            )}
            <div className="pb-4" />
          </div>
        )}

        {questionAggregates?.map(agg => {
          if (!agg) return null;
          const { question, responses: restResponses, aggregate } = agg;
          // Merge REST rows with live socket payloads (normalized), exclude
          // anything flagged or hidden — this screen faces the class.
          const live = (liveResponses[question.id] || [])
            .filter(r => !restResponses.some(rr => rr.student_id === r.studentId));
          const cleanRest = restResponses.filter(r => !r.is_flagged);
          const total = cleanRest.length + live.length;

          let displayOptions = aggregate?.options || [];
          if (aggregate?.type === 'tally' && live.length) {
            const tally = {};
            for (const r of live) for (const oid of (r.optionIds || [])) tally[oid] = (tally[oid] || 0) + 1;
            displayOptions = displayOptions.map(o => ({ ...o, count: o.count + (tally[o.id] || 0) }));
          }
          // Exit tickets prefix their comment with "Rating: N/4 —"; strip it
          // so the mechanical word doesn't dominate the cloud.
          const stripRating = (t) => String(t || '').replace(/^rating:\s*\d\/\d\s*(—|-)?\s*/i, '');
          const texts = [
            ...cleanRest.map(r => stripRating(r.text_value)),
            ...live.map(r => stripRating(r.textValue)),
          ].filter(Boolean);

          return (
            <div key={question.id} className="bg-white rounded-3xl shadow-sm border border-slate-200 px-8 py-6">
              <div className="flex items-start justify-between gap-4 mb-5">
                <h3 className="text-2xl font-bold text-slate-800 leading-snug">{question.prompt}</h3>
                <span className="text-lg font-bold text-indigo-600 bg-indigo-50 rounded-full px-4 py-1 flex-shrink-0">
                  {total} {total === 1 ? 'answer' : 'answers'}
                </span>
              </div>

              {aggregate?.type === 'tally' && (
                // Correct answers deliberately NOT highlighted here — this is
                // the class-facing screen; revealing the answer is the
                // teacher's call, on their own dashboard.
                <BigBars options={displayOptions.map(o => ({ ...o, is_correct: undefined }))} total={total} />
              )}

              {aggregate?.type === 'list' && (
                texts.length
                  ? <WordCloud texts={texts} />
                  : <p className="text-center text-slate-300 text-xl py-8">Waiting for answers…</p>
              )}
            </div>
          );
        })}
      </main>
    </div>
  );
}
