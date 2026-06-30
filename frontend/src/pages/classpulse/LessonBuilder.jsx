import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUESTION_TYPES = [
  { value: 'multiple_choice', label: 'Multiple Choice' },
  { value: 'true_false',      label: 'True / False'    },
  { value: 'short_answer',    label: 'Short Answer'    },
  { value: 'exit_ticket',     label: 'Exit Ticket'     },
];

const PAGE_TYPES = [
  { value: 'content',      label: 'Content Slide'  },
  { value: 'question',     label: 'Question Slide' },
  { value: 'exit_ticket',  label: 'Exit Ticket'    },
];

// ---------------------------------------------------------------------------
// Option editor (for MC / True-False)
// ---------------------------------------------------------------------------
function OptionEditor({ options, onChange }) {
  const add = () => onChange([...options, { text: '', is_correct: false }]);
  const update = (i, patch) => onChange(options.map((o, idx) => idx === i ? { ...o, ...patch } : o));
  const remove = i => onChange(options.filter((_, idx) => idx !== i));
  const markCorrect = i => onChange(options.map((o, idx) => ({ ...o, is_correct: idx === i })));

  return (
    <div className="space-y-2">
      {options.map((opt, i) => (
        <div key={i} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => markCorrect(i)}
            title="Mark as correct"
            className={`w-5 h-5 rounded-full border-2 flex-shrink-0 transition-colors ${
              opt.is_correct ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 hover:border-emerald-400'
            }`}
          />
          <input
            value={opt.text}
            onChange={e => update(i, { text: e.target.value })}
            placeholder={`Option ${i + 1}`}
            className="input flex-1 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-slate-400 hover:text-rose-500 transition-colors flex-shrink-0"
          >
            ✕
          </button>
        </div>
      ))}
      {options.length < 8 && (
        <button
          type="button"
          onClick={add}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
        >
          + Add option
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Question editor — inline within a page
// ---------------------------------------------------------------------------
function QuestionEditor({ question, pageId, onSaved, onDeleted }) {
  const [prompt,    setPrompt]    = useState(question.prompt || '');
  const [options,   setOptions]   = useState(question.options || []);
  const [settings,  setSettings]  = useState(question.settings || {});
  const [saving,    setSaving]    = useState(false);
  const [dirty,     setDirty]     = useState(false);

  const isNew = question.id === '_new';

  const needsOptions = ['multiple_choice', 'true_false'].includes(question.question_type);

  const save = useCallback(async () => {
    if (!prompt.trim()) return;
    setSaving(true);
    try {
      if (isNew) {
        const created = await api.post(`/classpulse/pages/${pageId}/questions`, {
          question_type: question.question_type,
          prompt: prompt.trim(),
          options: needsOptions ? options.filter(o => o.text.trim()) : [],
          settings,
        });
        onSaved(created);
      } else {
        const updated = await api.put(`/classpulse/questions/${question.id}`, {
          prompt: prompt.trim(),
          options: needsOptions ? options.filter(o => o.text.trim()) : undefined,
          settings,
        });
        onSaved(updated);
      }
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [prompt, options, settings, isNew, question, pageId, needsOptions, onSaved]);

  const del = async () => {
    if (isNew) { onDeleted(question.id); return; }
    await api.delete(`/classpulse/questions/${question.id}`);
    onDeleted(question.id);
  };

  return (
    <div className="border border-slate-200 rounded-xl p-4 space-y-3 bg-white">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-indigo-500 uppercase tracking-wide">
          {QUESTION_TYPES.find(t => t.value === question.question_type)?.label || question.question_type}
        </span>
        <button onClick={del} className="text-xs text-slate-400 hover:text-rose-500">Delete</button>
      </div>

      <textarea
        value={prompt}
        onChange={e => { setPrompt(e.target.value); setDirty(true); }}
        placeholder="Question prompt…"
        rows={2}
        className="input w-full resize-none text-sm"
      />

      {needsOptions && (
        <OptionEditor
          options={options}
          onChange={opts => { setOptions(opts); setDirty(true); }}
        />
      )}

      {question.question_type === 'true_false' && options.length === 0 && (
        <p className="text-xs text-slate-400">
          True/False questions use "True" and "False" as options — add them above or they'll be auto-created on save.
        </p>
      )}

      {question.question_type === 'short_answer' && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">Max characters:</label>
          <input
            type="number"
            min={50}
            max={2000}
            value={settings.max_chars || 500}
            onChange={e => { setSettings(s => ({ ...s, max_chars: parseInt(e.target.value) || 500 })); setDirty(true); }}
            className="input w-24 py-1 text-sm"
          />
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={save}
          disabled={saving || !prompt.trim() || !dirty}
          className="btn btn-primary text-xs py-1.5 px-4"
        >
          {saving ? 'Saving…' : isNew ? 'Add question' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page editor — right panel
// ---------------------------------------------------------------------------
function PageEditor({ page, lessonId, onPageUpdated, onPageDeleted }) {
  const [title,        setTitle]        = useState(page.title || '');
  const [body,         setBody]         = useState(page.body || '');
  const [teacherNotes, setTeacherNotes] = useState(page.teacher_notes || '');
  const [instructions, setInstructions] = useState(page.student_instructions || '');
  const [questions,    setQuestions]    = useState(page.questions || []);
  const [saving,       setSaving]       = useState(false);
  const [addQType,     setAddQType]     = useState('');

  // Re-sync when parent switches to a different page
  useEffect(() => {
    setTitle(page.title || '');
    setBody(page.body || '');
    setTeacherNotes(page.teacher_notes || '');
    setInstructions(page.student_instructions || '');
    setQuestions(page.questions || []);
    setAddQType('');
  }, [page.id]);

  const savePage = async () => {
    setSaving(true);
    try {
      const updated = await api.put(`/classpulse/lessons/${lessonId}/pages/${page.id}`, {
        title:               title   || null,
        body:                body    || null,
        teacher_notes:       teacherNotes || null,
        student_instructions: instructions || null,
      });
      onPageUpdated({ ...page, ...updated });
    } finally {
      setSaving(false);
    }
  };

  const deletePage = async () => {
    if (!window.confirm('Delete this slide?')) return;
    await api.delete(`/classpulse/lessons/${lessonId}/pages/${page.id}`);
    onPageDeleted(page.id);
  };

  const addQuestion = () => {
    if (!addQType) return;
    const stub = {
      id:            '_new',
      question_type: addQType,
      prompt:        '',
      options:       addQType === 'true_false'
        ? [{ text: 'True', is_correct: false }, { text: 'False', is_correct: false }]
        : addQType === 'multiple_choice' ? [{ text: '', is_correct: false }, { text: '', is_correct: false }]
        : [],
      settings: {},
    };
    setQuestions(qs => [...qs, stub]);
    setAddQType('');
  };

  const onQuestionSaved = saved => {
    setQuestions(qs => qs.map(q => (q.id === '_new' || q.id === saved.id) ? { ...q, ...saved } : q));
  };

  const onQuestionDeleted = id => {
    setQuestions(qs => qs.filter(q => q.id !== id));
  };

  const showBody         = page.content_type === 'content' || !page.content_type;
  const showQuestions    = page.content_type === 'question' || page.content_type === 'exit_ticket';

  return (
    <div className="space-y-5">
      {/* Page meta controls */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            {PAGE_TYPES.find(t => t.value === page.content_type)?.label || 'Slide'} · Position {page.position}
          </p>
        </div>
        <button onClick={deletePage} className="text-xs text-slate-400 hover:text-rose-500 flex-shrink-0">
          Delete slide
        </button>
      </div>

      {/* Title */}
      <div>
        <label className="block text-xs font-semibold text-slate-600 mb-1.5">Slide title</label>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Add a title…"
          className="input w-full"
        />
      </div>

      {/* Body — content slides */}
      {showBody && (
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5">Content</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Slide content, instructions, discussion prompt…"
            rows={5}
            className="input w-full resize-y text-sm"
          />
        </div>
      )}

      {/* Student instructions */}
      <div>
        <label className="block text-xs font-semibold text-slate-600 mb-1.5">
          Student instructions <span className="text-slate-400 font-normal">(shown on join page)</span>
        </label>
        <textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          placeholder="e.g. 'Read the paragraph, then answer the question below'"
          rows={2}
          className="input w-full resize-none text-sm"
        />
      </div>

      {/* Teacher notes */}
      <div>
        <label className="block text-xs font-semibold text-slate-600 mb-1.5">
          Teacher notes <span className="text-slate-400 font-normal">(not shown to students)</span>
        </label>
        <textarea
          value={teacherNotes}
          onChange={e => setTeacherNotes(e.target.value)}
          placeholder="Discussion tips, pacing notes, answers…"
          rows={2}
          className="input w-full resize-none text-sm"
        />
      </div>

      <button onClick={savePage} disabled={saving} className="btn btn-primary w-full">
        {saving ? 'Saving…' : 'Save slide'}
      </button>

      {/* Questions section */}
      {(showQuestions || questions.length > 0) && (
        <div className="pt-2 border-t border-slate-200 space-y-4">
          <h3 className="text-sm font-semibold text-slate-700">Questions</h3>

          {questions.map(q => (
            <QuestionEditor
              key={q.id}
              question={q}
              pageId={page.id}
              onSaved={onQuestionSaved}
              onDeleted={onQuestionDeleted}
            />
          ))}

          <div className="flex gap-2">
            <select
              value={addQType}
              onChange={e => setAddQType(e.target.value)}
              className="input flex-1 text-sm"
            >
              <option value="">Add a question…</option>
              {QUESTION_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <button
              onClick={addQuestion}
              disabled={!addQType}
              className="btn btn-secondary text-sm px-4"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-page panel
// ---------------------------------------------------------------------------
function AddPagePanel({ lessonId, currentPageCount, onAdded, onCancel }) {
  const [contentType, setContentType] = useState('content');
  const [title, setTitle]             = useState('');
  const [adding, setAdding]           = useState(false);

  const submit = async () => {
    setAdding(true);
    try {
      const page = await api.post(`/classpulse/lessons/${lessonId}/pages`, {
        content_type: contentType,
        title:        title || null,
        position:     currentPageCount + 1,
      });
      onAdded(page);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="border border-dashed border-indigo-300 rounded-xl p-4 bg-indigo-50 space-y-3">
      <p className="text-sm font-semibold text-indigo-700">New slide</p>
      <select value={contentType} onChange={e => setContentType(e.target.value)} className="input w-full text-sm">
        {PAGE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Slide title (optional)"
        className="input w-full text-sm"
      />
      <div className="flex gap-2">
        <button onClick={onCancel} className="btn btn-secondary text-sm flex-1">Cancel</button>
        <button onClick={submit} disabled={adding} className="btn btn-primary text-sm flex-1">
          {adding ? 'Adding…' : 'Add slide'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lesson header (title / metadata editor)
// ---------------------------------------------------------------------------
function LessonHeader({ lesson, onSaved }) {
  const [open,        setOpen]        = useState(false);
  const [title,       setTitle]       = useState(lesson.title || '');
  const [description, setDescription] = useState(lesson.description || '');
  const [subject,     setSubject]     = useState(lesson.subject || '');
  const [gradeLevel,  setGradeLevel]  = useState(lesson.grade_level || '');
  const [status,      setStatus]      = useState(lesson.status || 'draft');
  const [tagsInput,   setTagsInput]   = useState((lesson.tags || []).join(', '));
  const [saving,      setSaving]      = useState(false);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const updated = await api.put(`/classpulse/lessons/${lesson.id}`, {
        title: title.trim(),
        description: description || null,
        subject:     subject || null,
        grade_level: gradeLevel || null,
        status,
        tags: tagsInput.split(',').map(t => t.trim()).filter(Boolean),
      });
      onSaved(updated);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border-b border-slate-200 px-6 py-4">
      <div className="flex items-center justify-between gap-4 max-w-5xl mx-auto">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-800 truncate">{lesson.title}</h1>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize
              ${lesson.status === 'published' ? 'bg-emerald-50 text-emerald-700' :
                lesson.status === 'archived'  ? 'bg-amber-50 text-amber-600' :
                'bg-slate-100 text-slate-500'}`}>
              {lesson.status}
            </span>
            {lesson.subject && <span className="text-xs text-slate-400">{lesson.subject}</span>}
            {lesson.grade_level && <span className="text-xs text-slate-400">· {lesson.grade_level}</span>}
          </div>
        </div>
        <button onClick={() => setOpen(o => !o)} className="btn btn-secondary text-sm flex-shrink-0">
          {open ? 'Close' : 'Edit info'}
        </button>
      </div>

      {open && (
        <div className="mt-4 max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Title *</label>
            <input value={title} onChange={e => setTitle(e.target.value)} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} className="input w-full">
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Science" className="input w-full" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Grade level</label>
            <input value={gradeLevel} onChange={e => setGradeLevel(e.target.value)} placeholder="e.g. 9th Grade" className="input w-full" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-slate-600 mb-1">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} className="input w-full resize-none text-sm" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Tags <span className="text-slate-400 font-normal">(comma-separated)</span>
            </label>
            <input value={tagsInput} onChange={e => setTagsInput(e.target.value)} placeholder="review, vocab, chapter 3" className="input w-full" />
          </div>
          <div className="sm:col-span-2 flex justify-end gap-2">
            <button onClick={() => setOpen(false)} className="btn btn-secondary text-sm">Cancel</button>
            <button onClick={save} disabled={saving || !title.trim()} className="btn btn-primary text-sm">
              {saving ? 'Saving…' : 'Save lesson info'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main LessonBuilder
// ---------------------------------------------------------------------------
export default function LessonBuilder() {
  const { id: lessonId } = useParams();
  const navigate = useNavigate();
  const isNew = !lessonId || lessonId === 'new';

  const [lesson,     setLesson]     = useState(null);
  const [pages,      setPages]      = useState([]);
  const [activePageId, setActivePid] = useState(null);
  const [showAddPage, setShowAdd]   = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [creating,   setCreating]   = useState(false);

  // Create a brand-new lesson then redirect into edit mode
  useEffect(() => {
    if (!isNew) return;
    setCreating(true);
    api.post('/classpulse/lessons', { title: 'Untitled Lesson', status: 'draft' })
      .then(created => {
        navigate(`/classpulse/lessons/${created.id}/edit`, { replace: true });
      })
      .catch(e => {
        setError(e.message || 'Failed to create lesson');
        setCreating(false);
        setLoading(false);
      });
  }, [isNew, navigate]);

  // Fetch lesson (only when we have a real ID).
  // Guard on isNew only — not on creating, which stays true until the component
  // re-renders after the navigate() call and would block this effect from running.
  useEffect(() => {
    if (isNew) return;
    setLoading(true);
    api.get(`/classpulse/lessons/${lessonId}`)
      .then(data => {
        // API returns the lesson object directly with pages already nested
        // (each page has .questions, each question has .options — see getLessonDetail()).
        setLesson(data);
        const sorted = [...(data.pages || [])].sort((a, b) => a.position - b.position);
        setPages(sorted);
        setActivePid(sorted[0]?.id || null);
      })
      .catch(e => setError(e.message || 'Failed to load lesson'))
      .finally(() => setLoading(false));
  }, [lessonId, isNew]);

  const activePage = pages.find(p => p.id === activePageId) || null;

  const moveUp = async (idx) => {
    if (idx === 0) return;
    const newOrder = [...pages];
    [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
    setPages(newOrder);
    await api.put(`/classpulse/lessons/${lessonId}/pages/reorder`, {
      order: newOrder.map(p => p.id),
    });
    // Re-fetch to get canonical positions
    const data = await api.get(`/classpulse/lessons/${lessonId}`);
    const sorted = [...(data.pages || [])].sort((a, b) => a.position - b.position);
    setPages(prev => sorted.map(p => ({
      ...p,
      questions: prev.find(x => x.id === p.id)?.questions || [],
    })));
  };

  const moveDown = async (idx) => {
    if (idx >= pages.length - 1) return;
    const newOrder = [...pages];
    [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
    setPages(newOrder);
    await api.put(`/classpulse/lessons/${lessonId}/pages/reorder`, {
      order: newOrder.map(p => p.id),
    });
    const data = await api.get(`/classpulse/lessons/${lessonId}`);
    const sorted = [...(data.pages || [])].sort((a, b) => a.position - b.position);
    setPages(prev => sorted.map(p => ({
      ...p,
      questions: prev.find(x => x.id === p.id)?.questions || [],
    })));
  };

  const onPageAdded = (page) => {
    const newPage = { ...page, questions: [] };
    setPages(prev => [...prev, newPage].sort((a, b) => a.position - b.position));
    setActivePid(page.id);
    setShowAdd(false);
  };

  const onPageUpdated = (updated) => {
    setPages(prev => prev.map(p => p.id === updated.id ? { ...updated, questions: p.questions } : p));
  };

  const onPageDeleted = (id) => {
    setPages(prev => {
      const remaining = prev.filter(p => p.id !== id);
      setActivePid(remaining[0]?.id || null);
      return remaining;
    });
  };

  const onLessonSaved = (updated) => setLesson(updated);

  if (creating || (isNew && !error)) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-slate-400 text-sm">Creating lesson…</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-slate-400 text-sm">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <p className="text-rose-600 font-medium mb-3">{error}</p>
          <button onClick={() => navigate('/classpulse/lessons')} className="btn btn-secondary text-sm">
            Back to library
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-50">
      {/* Lesson header */}
      {lesson && <LessonHeader lesson={lesson} onSaved={onLessonSaved} />}

      {/* Builder body */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left panel — page list */}
        <aside className="w-56 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col overflow-hidden">
          <div className="px-3 py-3 border-b border-slate-100 flex-shrink-0">
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">Slides</p>
          </div>
          <div className="flex-1 overflow-y-auto py-2 space-y-0.5 px-2">
            {pages.length === 0 && (
              <p className="text-xs text-slate-400 text-center py-6">No slides yet</p>
            )}
            {pages.map((page, idx) => (
              <div
                key={page.id}
                className={`group relative rounded-lg transition-colors ${
                  activePageId === page.id
                    ? 'bg-indigo-50 border border-indigo-200'
                    : 'hover:bg-slate-50 border border-transparent'
                }`}
              >
                <button
                  className="w-full text-left px-3 py-2.5"
                  onClick={() => { setActivePid(page.id); setShowAdd(false); }}
                >
                  <p className="text-[10px] font-semibold text-slate-400 uppercase leading-none mb-0.5">
                    {idx + 1} · {PAGE_TYPES.find(t => t.value === page.content_type)?.label || 'Slide'}
                  </p>
                  <p className="text-xs text-slate-700 font-medium line-clamp-2 leading-snug">
                    {page.title || <span className="italic text-slate-400">Untitled</span>}
                  </p>
                  {page.questions?.length > 0 && (
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {page.questions.length} question{page.questions.length > 1 ? 's' : ''}
                    </p>
                  )}
                </button>
                {/* Up/down reorder */}
                <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex flex-col gap-0.5">
                  <button
                    onClick={() => moveUp(idx)}
                    disabled={idx === 0}
                    className="text-slate-400 hover:text-slate-700 disabled:opacity-30 leading-none text-xs px-0.5"
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => moveDown(idx)}
                    disabled={idx >= pages.length - 1}
                    className="text-slate-400 hover:text-slate-700 disabled:opacity-30 leading-none text-xs px-0.5"
                    title="Move down"
                  >
                    ▼
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Add page */}
          <div className="px-2 py-2 border-t border-slate-100 flex-shrink-0">
            {showAddPage ? (
              <AddPagePanel
                lessonId={lessonId}
                currentPageCount={pages.length}
                onAdded={onPageAdded}
                onCancel={() => setShowAdd(false)}
              />
            ) : (
              <button
                onClick={() => setShowAdd(true)}
                className="w-full text-xs text-indigo-600 hover:text-indigo-800 font-semibold py-2 rounded-lg hover:bg-indigo-50 transition-colors"
              >
                + Add slide
              </button>
            )}
          </div>
        </aside>

        {/* Right panel — page editor */}
        <main className="flex-1 overflow-y-auto">
          {activePage ? (
            <div className="p-6 max-w-2xl mx-auto">
              <PageEditor
                key={activePage.id}
                page={activePage}
                lessonId={lessonId}
                onPageUpdated={onPageUpdated}
                onPageDeleted={onPageDeleted}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-slate-400">
                <p className="text-sm mb-3">
                  {pages.length === 0 ? 'Add your first slide to get started' : 'Select a slide to edit'}
                </p>
                {pages.length === 0 && (
                  <button onClick={() => setShowAdd(true)} className="btn btn-primary text-sm">
                    Add slide
                  </button>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
