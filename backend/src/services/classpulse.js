const { query, pool } = require('../db');

// ---------------------------------------------------------------------------
// Join Code
// ---------------------------------------------------------------------------

// 6-character uppercase alphanumeric, excluding visually confusable chars
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateJoinCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

async function generateUniqueJoinCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateJoinCode();
    const { rows } = await query(
      `SELECT 1 FROM classpulse_sessions WHERE join_code = $1 AND status = 'active'`,
      [code]
    );
    if (!rows.length) return code;
  }
  throw new Error('Failed to generate a unique join code after 20 attempts');
}

// ---------------------------------------------------------------------------
// Class Pulse Score
// ---------------------------------------------------------------------------
// 40% participation + 40% comprehension + 20% focus
// Called on every response event and off-task event to keep the gauge live.

async function calcPulseScore(sessionId, focusData = null) {
  const [{ rows: students }, { rows: responses }, { rows: session }] = await Promise.all([
    query(
      `SELECT student_id FROM classpulse_session_students
       WHERE session_id = $1 AND status = 'active'`,
      [sessionId]
    ),
    query(
      `SELECT r.student_id, r.question_id, r.option_ids, r.text_value, r.numeric_value,
              q.question_type, q.settings
       FROM classpulse_responses r
       JOIN classpulse_questions q ON q.id = r.question_id
       WHERE r.session_id = $1`,
      [sessionId]
    ),
    query(
      `SELECT current_page_id FROM classpulse_sessions WHERE id = $1`,
      [sessionId]
    ),
  ]);

  const totalStudents = students.length;
  if (totalStudents === 0) return { score: 0, participation: 0, comprehension: 0, focus: 100 };

  const currentPageId = session[0]?.current_page_id;

  // Participation: % of students who submitted at least one response to any
  // question on the current page (or overall if no current page).
  let participatingStudents;
  if (currentPageId) {
    const { rows: pageQuestions } = await query(
      `SELECT id FROM classpulse_questions WHERE page_id = $1`,
      [currentPageId]
    );
    const pageQIds = new Set(pageQuestions.map(q => q.id));
    participatingStudents = new Set(
      responses.filter(r => pageQIds.has(r.question_id)).map(r => r.student_id)
    ).size;
  } else {
    participatingStudents = new Set(responses.map(r => r.student_id)).size;
  }
  const participation = totalStudents > 0
    ? Math.round((participatingStudents / totalStudents) * 100)
    : 0;

  // Comprehension: aggregate across responses where a meaningful score exists.
  // - multiple_choice / true_false: % of responses matching a correct option
  // - short_answer / exit_ticket: proxy = participation (no auto-grade)
  // - numeric: normalized against settings.max (if set), else participation proxy
  // - mood / rating: normalized against scale max
  let comprehensionTotal = 0;
  let comprehensionSamples = 0;

  const byQuestion = {};
  for (const r of responses) {
    if (!byQuestion[r.question_id]) byQuestion[r.question_id] = { type: r.question_type, settings: r.settings, rows: [] };
    byQuestion[r.question_id].rows.push(r);
  }

  for (const [qId, { type, settings, rows: qResponses }] of Object.entries(byQuestion)) {
    if (type === 'multiple_choice' || type === 'true_false') {
      const { rows: correctOptions } = await query(
        `SELECT id FROM classpulse_question_options WHERE question_id = $1 AND is_correct = true`,
        [qId]
      );
      if (!correctOptions.length) continue;
      const correctIds = new Set(correctOptions.map(o => o.id));
      const correct = qResponses.filter(r =>
        r.option_ids && r.option_ids.some(id => correctIds.has(id))
      ).length;
      comprehensionTotal += Math.round((correct / qResponses.length) * 100);
      comprehensionSamples++;
    } else if (type === 'rating') {
      const max = settings?.scale_max ?? 5;
      const min = settings?.scale_min ?? 1;
      const range = max - min;
      if (range > 0) {
        const avgRaw = qResponses.reduce((s, r) => s + (Number(r.numeric_value) || min), 0) / qResponses.length;
        comprehensionTotal += Math.round(((avgRaw - min) / range) * 100);
        comprehensionSamples++;
      }
    }
    // short_answer, exit_ticket, paragraph: no comprehension signal; skip
  }

  const comprehension = comprehensionSamples > 0
    ? Math.round(comprehensionTotal / comprehensionSamples)
    : participation; // fall back to participation when no gradeable questions

  // Focus: % of students NOT showing off-task indicators in last 60s.
  // focusData is an optional map of { studentId -> offTaskAt (timestamp) }.
  // Passed in from the socket layer which tracks off-task activity events.
  let focus = 100;
  if (focusData && totalStudents > 0) {
    const cutoff = Date.now() - 60_000;
    const offTask = students.filter(s =>
      focusData[s.student_id] && focusData[s.student_id] > cutoff
    ).length;
    focus = Math.round(((totalStudents - offTask) / totalStudents) * 100);
  }

  const score = Math.round(0.4 * participation + 0.4 * comprehension + 0.2 * focus);

  return { score, participation, comprehension, focus };
}

// ---------------------------------------------------------------------------
// Response Aggregation (for dashboard REST poll + session report)
// ---------------------------------------------------------------------------

async function aggregateResponses(sessionId, questionId) {
  const [{ rows: question }, { rows: responses }, { rows: options }] = await Promise.all([
    query(
      `SELECT q.*, p.lesson_id FROM classpulse_questions q
       JOIN classpulse_pages p ON p.id = q.page_id
       WHERE q.id = $1`,
      [questionId]
    ),
    query(
      `SELECT r.*, u.full_name
       FROM classpulse_responses r
       JOIN users u ON u.id = r.student_id
       WHERE r.session_id = $1 AND r.question_id = $2 AND r.is_hidden = false
       ORDER BY r.submitted_at`,
      [sessionId, questionId]
    ),
    query(
      `SELECT * FROM classpulse_question_options WHERE question_id = $1 ORDER BY position`,
      [questionId]
    ),
  ]);

  if (!question.length) return null;
  const q = question[0];

  let aggregate = null;
  if (q.question_type === 'multiple_choice' || q.question_type === 'true_false') {
    const tally = {};
    for (const o of options) tally[o.id] = { text: o.text, is_correct: o.is_correct, count: 0 };
    for (const r of responses) {
      for (const id of (r.option_ids || [])) {
        if (tally[id]) tally[id].count++;
      }
    }
    aggregate = { type: 'tally', options: Object.entries(tally).map(([id, v]) => ({ id, ...v })) };
  } else if (q.question_type === 'short_answer' || q.question_type === 'exit_ticket') {
    aggregate = { type: 'list' };
  }

  return {
    question:  { id: q.id, type: q.question_type, prompt: q.prompt, settings: q.settings, options },
    responses: responses.map((r, i) => ({
      id:             r.id,
      anonymousOrder: i + 1,
      text_value:     r.text_value,
      option_ids:     r.option_ids,
      submitted_at:   r.submitted_at,
      is_flagged:     r.is_flagged,
      // name is included here for the teacher-only REST response;
      // the socket fan-out strips the name before broadcasting
      student_name:   r.full_name,
    })),
    aggregate,
    total_responses: responses.length,
  };
}

// ---------------------------------------------------------------------------
// Session Report
// ---------------------------------------------------------------------------

async function buildSessionReport(sessionId) {
  const [{ rows: [session] }, { rows: students }, { rows: allResponses }] = await Promise.all([
    query(
      `SELECT s.*, u.full_name AS teacher_name,
              l.title AS lesson_title, c.name AS class_name
       FROM classpulse_sessions s
       JOIN users u ON u.id = s.teacher_id
       LEFT JOIN classpulse_lessons l ON l.id = s.lesson_id
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.id = $1`,
      [sessionId]
    ),
    query(
      `SELECT ss.student_id, ss.joined_at, ss.last_seen_at, ss.status,
              u.full_name, u.email
       FROM classpulse_session_students ss
       JOIN users u ON u.id = ss.student_id
       WHERE ss.session_id = $1
       ORDER BY u.full_name`,
      [sessionId]
    ),
    query(
      `SELECT r.*, q.prompt, q.question_type, p.title AS page_title, p.position
       FROM classpulse_responses r
       JOIN classpulse_questions q ON q.id = r.question_id
       JOIN classpulse_pages p ON p.id = q.page_id
       WHERE r.session_id = $1
       ORDER BY p.position, q.position, r.submitted_at`,
      [sessionId]
    ),
  ]);

  if (!session) return null;

  const durationMs = session.ended_at
    ? new Date(session.ended_at) - new Date(session.started_at)
    : Date.now() - new Date(session.started_at);
  const durationMin = Math.round(durationMs / 60_000);

  const respondingStudents = new Set(allResponses.map(r => r.student_id)).size;
  const participationPct = students.length > 0
    ? Math.round((respondingStudents / students.length) * 100)
    : 0;

  // Group responses by question
  const byQuestion = {};
  for (const r of allResponses) {
    if (!byQuestion[r.question_id]) {
      byQuestion[r.question_id] = {
        question_id:   r.question_id,
        prompt:        r.prompt,
        question_type: r.question_type,
        page_title:    r.page_title,
        page_position: r.position,
        responses:     [],
      };
    }
    byQuestion[r.question_id].responses.push({
      student_id:   r.student_id,
      text_value:   r.text_value,
      option_ids:   r.option_ids,
      submitted_at: r.submitted_at,
      is_flagged:   r.is_flagged,
    });
  }

  return {
    session: {
      id:               session.id,
      join_code:        session.join_code,
      mode:             session.mode,
      status:           session.status,
      teacher_name:     session.teacher_name,
      lesson_title:     session.lesson_title,
      class_name:       session.class_name,
      started_at:       session.started_at,
      ended_at:         session.ended_at,
      duration_minutes: durationMin,
      teacher_comments: session.teacher_comments,
    },
    participation: {
      total_joined:       students.length,
      responded:          respondingStudents,
      participation_pct:  participationPct,
    },
    students,
    questions: Object.values(byQuestion).sort((a, b) => a.page_position - b.page_position),
    total_responses: allResponses.length,
    flagged_count:   allResponses.filter(r => r.is_flagged).length,
  };
}

module.exports = {
  generateUniqueJoinCode,
  calcPulseScore,
  aggregateResponses,
  buildSessionReport,
};
