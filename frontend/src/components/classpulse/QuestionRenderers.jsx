import { useState } from 'react';

// ---------------------------------------------------------------------------
// Question renderers — shared by the live student join page (/pulse/:code)
// and the teacher-facing lesson preview.
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

export function QuestionRenderer({ question, onSubmit, submitted }) {
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

