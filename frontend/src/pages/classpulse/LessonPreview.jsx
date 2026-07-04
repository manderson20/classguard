import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '../../lib/api';
import { QuestionRenderer } from '../../components/classpulse/QuestionRenderers';

// Teacher-facing preview: renders each page exactly the way the student join
// page (/pulse/:code) does, without a live session. Answers aren't recorded —
// submitting just flips the local "submitted" state so the teacher sees the
// same confirmation a student would.
export default function LessonPreview() {
  const { id: lessonId } = useParams();
  const [pageIdx, setPageIdx]   = useState(0);
  const [submitted, setSubmitted] = useState({}); // { questionId: true }, per preview only

  const { data: lesson, isLoading, error } = useQuery({
    queryKey: ['classpulse-lesson', lessonId],
    queryFn:  () => api.get(`/classpulse/lessons/${lessonId}`),
  });

  if (isLoading) {
    return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-400">Loading preview…</div>;
  }
  if (error || !lesson) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-rose-600 text-sm mb-3">{error?.message || 'Lesson not found'}</p>
          <Link to="/classpulse/lessons" className="btn btn-secondary text-sm">Back to library</Link>
        </div>
      </div>
    );
  }

  const pages = [...(lesson.pages || [])].sort((a, b) => a.position - b.position);
  const page  = pages[pageIdx] || null;
  const questions = page?.questions || [];

  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-slate-50 flex flex-col">
      {/* Preview banner */}
      <div className="bg-amber-400 text-amber-950 text-center text-xs font-semibold py-1.5 flex-shrink-0">
        Preview — this is what students see. Responses are not recorded.
        <Link to={`/classpulse/lessons/${lessonId}/edit`} className="underline ml-2">Back to builder</Link>
      </div>

      {/* Student-style header */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs text-slate-400 font-medium truncate">ClassPulse</p>
            <p className="text-sm font-semibold text-slate-700 truncate">{lesson.title}</p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1 ml-3 flex-shrink-0">
            Preview
          </span>
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 py-6 space-y-4 w-full flex-1">
        {pages.length === 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center text-sm text-slate-400">
            This lesson has no slides yet.
          </div>
        )}

        {page && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            {page.title && (
              <div className="bg-indigo-600 px-5 py-4">
                <p className="text-xs text-indigo-200 font-medium mb-0.5">Slide {pageIdx + 1} of {pages.length}</p>
                <h2 className="text-white font-bold text-lg leading-snug">{page.title}</h2>
              </div>
            )}
            {page.body && (
              <div className="px-5 py-4">
                <p className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">{page.body}</p>
              </div>
            )}
            {page.student_instructions && (
              <div className="mx-5 mb-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
                <p className="text-xs font-semibold text-amber-700 mb-1">Instructions</p>
                <p className="text-sm text-amber-800 leading-relaxed">{page.student_instructions}</p>
              </div>
            )}
          </div>
        )}

        {questions.map(question => (
          <div key={question.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 px-5 py-5">
            <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-2">
              {question.question_type === 'exit_ticket' ? 'Exit Ticket' :
               question.question_type === 'true_false'  ? 'True or False' :
               question.question_type === 'short_answer' ? 'Short Answer' :
               'Question'}
            </p>
            <p className="text-slate-800 font-semibold text-base leading-snug">{question.prompt}</p>
            <QuestionRenderer
              question={question}
              onSubmit={(payload) => setSubmitted(prev => ({ ...prev, [payload.question_id]: true }))}
              submitted={!!submitted[question.id]}
            />
          </div>
        ))}
      </div>

      {/* Teacher paging controls (students don't get these — the teacher
          drives paging in a real session) */}
      <div className="bg-white border-t border-slate-200 px-4 py-3 flex items-center gap-3 sticky bottom-0">
        <button
          onClick={() => setPageIdx(i => Math.max(0, i - 1))}
          disabled={pageIdx <= 0}
          className="btn btn-secondary text-sm px-4 disabled:opacity-40"
        >
          ← Prev
        </button>
        <div className="flex-1 flex items-center justify-center gap-2">
          {pages.map((p, idx) => (
            <button
              key={p.id}
              onClick={() => setPageIdx(idx)}
              title={p.title || `Slide ${idx + 1}`}
              className={`w-2.5 h-2.5 rounded-full transition-all ${idx === pageIdx ? 'bg-indigo-600 scale-125' : 'bg-slate-300 hover:bg-slate-400'}`}
            />
          ))}
        </div>
        <button
          onClick={() => setPageIdx(i => Math.min(pages.length - 1, i + 1))}
          disabled={pageIdx >= pages.length - 1}
          className="btn btn-primary text-sm px-4 disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
