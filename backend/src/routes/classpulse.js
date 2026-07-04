const { Router } = require('express');
const { query, withTransaction } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermissionIfAdmin } = require('../middleware/permissions');
const { generateUniqueJoinCode, calcPulseScore, aggregateResponses, buildSessionReport } = require('../services/classpulse');
const events = require('../events');
const fs = require('fs');
const googleSlides = require('../services/googleSlides');
const redis  = require('../redis');

// Hard cap on options per question — prevents loop-bound injection from
// unbounded user-supplied arrays and keeps the DB sane.
const MAX_OPTIONS = 26;

const router = Router();

// ---------------------------------------------------------------------------
// Public / student-accessible routes (BEFORE the teacher-auth gate)
// ---------------------------------------------------------------------------

// GET /classpulse/join/:code — validate join code, return session + current page
// No auth required — join code is the gate.
router.get('/join/:code', async (req, res) => {
  const { code } = req.params;
  const { rows: [session] } = await query(
    `SELECT s.id, s.mode, s.status, s.join_code, s.current_page_id,
            l.title AS lesson_title,
            u.full_name AS teacher_name,
            c.name AS class_name
     FROM classpulse_sessions s
     LEFT JOIN classpulse_lessons l ON l.id = s.lesson_id
     JOIN users u ON u.id = s.teacher_id
     LEFT JOIN classes c ON c.id = s.class_id
     WHERE s.join_code = $1 AND s.status = 'active'`,
    [code.toUpperCase()]
  );
  if (!session) return res.status(404).json({ error: 'Session not found or has ended' });

  // Current page (without correct-answer data)
  let currentPage = null;
  if (session.current_page_id) {
    const { rows: [page] } = await query(
      `SELECT id, position, content_type, title, body, student_instructions, image_url
       FROM classpulse_pages WHERE id = $1`,
      [session.current_page_id]
    );
    if (page) {
      const { rows: questions } = await query(
        `SELECT q.id, q.question_type, q.prompt, q.settings, q.position
         FROM classpulse_questions q WHERE q.page_id = $1 ORDER BY q.position`,
        [page.id]
      );
      const { rows: options } = await query(
        `SELECT o.id, o.text, o.position, o.question_id
         FROM classpulse_question_options o
         WHERE o.question_id = ANY($1::uuid[])
         ORDER BY o.question_id, o.position`,
        [questions.map(q => q.id)]
      );
      const optsByQ = {};
      for (const o of options) {
        if (!optsByQ[o.question_id]) optsByQ[o.question_id] = [];
        optsByQ[o.question_id].push(o);
      }
      currentPage = {
        ...page,
        questions: questions.map(q => ({ ...q, options: optsByQ[q.id] || [] })),
      };
    }
  }

  res.json({ session, currentPage });
});

// POST /classpulse/join/:code — student joins session (requires ClassGuard JWT)
router.post('/join/:code', authenticate, async (req, res) => {
  const { code } = req.params;
  const { userId } = req.user;

  const { rows: [session] } = await query(
    `SELECT id, class_id, current_page_id, join_code, classroom_lock_enabled
     FROM classpulse_sessions
     WHERE join_code = $1 AND status = 'active'`,
    [code.toUpperCase()]
  );
  if (!session) return res.status(404).json({ error: 'Session not found or has ended' });

  await query(
    `INSERT INTO classpulse_session_students (session_id, student_id)
     VALUES ($1, $2)
     ON CONFLICT (session_id, student_id)
     DO UPDATE SET last_seen_at = now(), status = 'active'`,
    [session.id, userId]
  );

  const { rows: [student] } = await query(
    `SELECT full_name FROM users WHERE id = $1`, [userId]
  );

  // Notify teacher dashboard
  events.emit('classpulse:student_joined', {
    sessionId: session.id,
    studentId: userId,
    studentName: student?.full_name || 'Student',
  });

  // Focus lock is already engaged for this session — apply it to this (late)
  // joiner too, or only students who were present when the teacher clicked
  // Lock would ever be locked.
  if (session.classroom_lock_enabled) {
    events.emit('teacher:lock_request', {
      studentId:  userId,
      message:    `ClassPulse session in progress — code: ${session.join_code}`,
      targetPath: `/pulse/${session.join_code}`,
      allowPulse: true,
    });
  }

  res.json({ session_id: session.id, current_page_id: session.current_page_id });
});

// GET /classpulse/sessions/:id/current — current page for a joined student
router.get('/sessions/:id/current', authenticate, async (req, res) => {
  const { id: sessionId } = req.params;
  const { userId } = req.user;

  const { rows: [session] } = await query(
    `SELECT current_page_id, status FROM classpulse_sessions WHERE id = $1`,
    [sessionId]
  );
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') return res.json({ ended: true });

  if (!session.current_page_id) return res.json({ page: null });

  const { rows: [page] } = await query(
    `SELECT id, position, content_type, title, body, student_instructions, image_url
     FROM classpulse_pages WHERE id = $1`,
    [session.current_page_id]
  );
  if (!page) return res.json({ page: null });

  const { rows: questions } = await query(
    `SELECT id, question_type, prompt, settings, position
     FROM classpulse_questions WHERE page_id = $1 ORDER BY position`,
    [page.id]
  );
  const { rows: options } = await query(
    `SELECT o.id, o.text, o.position, o.question_id
     FROM classpulse_question_options o
     WHERE o.question_id = ANY($1::uuid[]) ORDER BY o.question_id, o.position`,
    [questions.map(q => q.id)]
  );
  const optsByQ = {};
  for (const o of options) {
    if (!optsByQ[o.question_id]) optsByQ[o.question_id] = [];
    optsByQ[o.question_id].push({ id: o.id, text: o.text, position: o.position });
  }

  // Has this student already responded to each question?
  const { rows: myResponses } = await query(
    `SELECT question_id FROM classpulse_responses
     WHERE session_id = $1 AND student_id = $2
       AND question_id = ANY($3::uuid[])`,
    [sessionId, userId, questions.map(q => q.id)]
  );
  const responded = new Set(myResponses.map(r => r.question_id));

  res.json({
    page: {
      ...page,
      questions: questions.map(q => ({
        ...q,
        options: optsByQ[q.id] || [],
        already_responded: responded.has(q.id),
      })),
    },
  });
});

// POST /classpulse/sessions/:id/response — student submits a response
router.post('/sessions/:id/response', authenticate, async (req, res) => {
  const { id: sessionId } = req.params;
  const { userId } = req.user;
  const { question_id, response_type, text_value, option_ids, numeric_value } = req.body;

  if (!question_id) return res.status(400).json({ error: 'question_id is required' });
  if (!response_type) return res.status(400).json({ error: 'response_type is required' });

  // Verify session is active and student is joined
  const { rows: [session] } = await query(
    `SELECT s.id, s.class_id, s.lesson_id FROM classpulse_sessions s
     JOIN classpulse_session_students ss ON ss.session_id = s.id AND ss.student_id = $2
     WHERE s.id = $1 AND s.status = 'active'`,
    [sessionId, userId]
  );
  if (!session) return res.status(403).json({ error: 'Not joined to this session or session ended' });

  // Verify the question belongs to this session's lesson
  const { rows: [questionCheck] } = await query(
    `SELECT 1 FROM classpulse_questions q
     JOIN classpulse_pages p ON p.id = q.page_id
     WHERE q.id = $1 AND p.lesson_id = $2`,
    [question_id, session.lesson_id]
  );
  if (!questionCheck) return res.status(400).json({ error: 'Question does not belong to this session' });

  await query(
    `INSERT INTO classpulse_responses
       (session_id, question_id, student_id, response_type, text_value, option_ids, numeric_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (session_id, question_id, student_id)
     DO UPDATE SET
       text_value    = EXCLUDED.text_value,
       option_ids    = EXCLUDED.option_ids,
       numeric_value = EXCLUDED.numeric_value,
       submitted_at  = now()`,
    [sessionId, question_id, userId, response_type,
     text_value || null, option_ids || [], numeric_value || null]
  );

  // Update heartbeat
  await query(
    `UPDATE classpulse_session_students SET last_seen_at = now()
     WHERE session_id = $1 AND student_id = $2`,
    [sessionId, userId]
  );

  // Get student name for dashboard fan-out
  const { rows: [student] } = await query(
    `SELECT full_name FROM users WHERE id = $1`, [userId]
  );

  // Count responses to this question for anonymous ordering
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM classpulse_responses
     WHERE session_id = $1 AND question_id = $2 AND is_hidden = false`,
    [sessionId, question_id]
  );

  events.emit('classpulse:new_response', {
    sessionId,
    questionId:   question_id,
    studentId:    userId,
    studentName:  student?.full_name || 'Student',
    responseType: response_type,
    textValue:    text_value || null,
    optionIds:    option_ids || [],
    responseCount: count,
    classId:      session.class_id,
  });

  res.status(201).json({ ok: true });
});

// All remaining routes require at minimum a teacher login.
// Admin-only config actions additionally gate on 'classpulse' permission.
// GET /classpulse/slide-image/:pageId — streams an imported Google Slides
// page image. Students render these on the join page, so this sits before
// the teacher gate; any authenticated user with the page id may fetch (the
// image is lesson content, not sensitive data — same exposure as the page
// body text the same routes already return).
router.get('/slide-image/:pageId', authenticate, async (req, res) => {
  const { rows: [page] } = await query(
    `SELECT image_url FROM classpulse_pages WHERE id = $1`,
    [req.params.pageId]
  );
  if (!page?.image_url) return res.status(404).json({ error: 'No image for this page' });
  const abs = googleSlides.resolveSlideImagePath(page.image_url);
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: 'Image file not found' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(abs).pipe(res);
});

router.use(authenticate, requireMinRole('teacher'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAdminPlus(role) {
  return role === 'admin' || role === 'superadmin';
}

// Verify the calling teacher owns the lesson (or is admin+).
async function ownsLesson(lessonId, userId, role) {
  if (isAdminPlus(role)) return true;
  const { rows } = await query(
    `SELECT 1 FROM classpulse_lessons WHERE id = $1 AND teacher_id = $2`,
    [lessonId, userId]
  );
  return rows.length > 0;
}

// Fetch a full lesson with its pages and questions (and options) in one round-trip.
async function getLessonDetail(lessonId) {
  const [{ rows: [lesson] }, { rows: pages }, { rows: questions }, { rows: options }] =
    await Promise.all([
      query(`SELECT * FROM classpulse_lessons WHERE id = $1`, [lessonId]),
      query(
        `SELECT * FROM classpulse_pages WHERE lesson_id = $1 ORDER BY position`,
        [lessonId]
      ),
      query(
        `SELECT q.* FROM classpulse_questions q
         JOIN classpulse_pages p ON p.id = q.page_id
         WHERE p.lesson_id = $1
         ORDER BY p.position, q.position`,
        [lessonId]
      ),
      query(
        `SELECT o.* FROM classpulse_question_options o
         JOIN classpulse_questions q ON q.id = o.question_id
         JOIN classpulse_pages p ON p.id = q.page_id
         WHERE p.lesson_id = $1
         ORDER BY o.question_id, o.position`,
        [lessonId]
      ),
    ]);

  if (!lesson) return null;

  // Nest options → questions → pages
  const optsByQ = {};
  for (const o of options) {
    if (!optsByQ[o.question_id]) optsByQ[o.question_id] = [];
    optsByQ[o.question_id].push(o);
  }
  const qsByPage = {};
  for (const q of questions) {
    if (!qsByPage[q.page_id]) qsByPage[q.page_id] = [];
    qsByPage[q.page_id].push({ ...q, options: optsByQ[q.id] || [] });
  }

  return {
    ...lesson,
    pages: pages.map(p => ({ ...p, questions: qsByPage[p.id] || [] })),
  };
}

// ---------------------------------------------------------------------------
// Lessons — List
// ---------------------------------------------------------------------------

router.get('/lessons', async (req, res) => {
  const { userId, role } = req.user;
  const { search, tag, folder, status } = req.query;
  const adminPlus = isAdminPlus(role);

  const { rows: policyRows } = await query(`SELECT value FROM settings WHERE key = 'classpulse_lesson_sharing'`);
  const sharingPolicy = policyRows[0]?.value || 'school_wide';
  const sharingDisabled = sharingPolicy === 'own_only' && !adminPlus;

  const { rows } = await query(
    `SELECT l.*,
            u.full_name AS teacher_name,
            COUNT(DISTINCT p.id)::int AS page_count,
            COUNT(DISTINCT q.id)::int AS question_count,
            (NOT $7 AND EXISTS (
              SELECT 1 FROM classpulse_lesson_shares s
              WHERE s.lesson_id = l.id AND (s.shared_with = $1 OR s.shared_with IS NULL)
            )) AS is_shared_with_me
     FROM classpulse_lessons l
     JOIN users u ON u.id = l.teacher_id
     LEFT JOIN classpulse_pages p ON p.lesson_id = l.id
     LEFT JOIN classpulse_questions q ON q.page_id = p.id
     WHERE (
       l.teacher_id = $1
       OR (NOT $7 AND EXISTS (
         SELECT 1 FROM classpulse_lesson_shares s
         WHERE s.lesson_id = l.id AND (s.shared_with = $1 OR s.shared_with IS NULL)
       ))
       OR $2
     )
     AND ($3::text IS NULL OR l.title ILIKE '%' || $3 || '%' OR l.description ILIKE '%' || $3 || '%')
     AND ($4::text IS NULL OR $4 = ANY(l.tags))
     AND ($5::text IS NULL OR l.folder = $5)
     AND ($6::text IS NULL OR l.status = $6)
     GROUP BY l.id, u.full_name
     ORDER BY l.updated_at DESC`,
    [userId, adminPlus, search || null, tag || null, folder || null, status || null, sharingDisabled]
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Lessons — Create
// ---------------------------------------------------------------------------

router.post('/lessons', async (req, res) => {
  const { userId } = req.user;
  const { title, description, subject, grade_level, class_id, estimated_minutes, tags, folder } = req.body;

  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });

  const { rows: [lesson] } = await query(
    `INSERT INTO classpulse_lessons
       (teacher_id, title, description, subject, grade_level, class_id, estimated_minutes, tags, folder)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [userId, title.trim(), description || null, subject || null, grade_level || null,
     class_id || null, estimated_minutes || null, tags || [], folder || null]
  );
  res.status(201).json(lesson);
});

// ---------------------------------------------------------------------------
// Lessons — Get detail
// ---------------------------------------------------------------------------

router.get('/lessons/:lessonId', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;

  const lesson = await getLessonDetail(lessonId);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

  // Teachers can see own lessons or ones shared with them; admin+ sees all
  if (!isAdminPlus(role) && lesson.teacher_id !== userId) {
    const { rows } = await query(
      `SELECT 1 FROM classpulse_lesson_shares
       WHERE lesson_id = $1 AND (shared_with = $2 OR shared_with IS NULL)`,
      [lessonId, userId]
    );
    if (!rows.length) return res.status(403).json({ error: 'Forbidden' });
  }

  res.json(lesson);
});

// ---------------------------------------------------------------------------
// Lessons — Update
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Google Slides import — teacher's own decks via domain-wide delegation
// ---------------------------------------------------------------------------

router.get('/google-slides/presentations', async (req, res) => {
  try {
    const files = await googleSlides.listPresentations(req.user.email, req.query.search || '');
    res.json(files);
  } catch (err) {
    // Common, actionable failures: API not enabled on the GCP project, scope
    // missing from the delegation grant, or a non-Workspace account.
    res.status(502).json({ error: `Google Slides listing failed: ${err.message}` });
  }
});

router.post('/lessons/:lessonId/import-slides', async (req, res) => {
  const { userId, role, email } = req.user;
  const { lessonId } = req.params;
  const { presentation_id } = req.body;

  if (!presentation_id) return res.status(400).json({ error: 'presentation_id is required' });
  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await googleSlides.importPresentation(email, presentation_id, lessonId);
    res.status(201).json(result);
  } catch (err) {
    res.status(502).json({ error: `Slides import failed: ${err.message}` });
  }
});

router.put('/lessons/:lessonId', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { title, description, subject, grade_level, class_id, estimated_minutes, tags, folder, status } = req.body;

  const { rows: [lesson] } = await query(
    `UPDATE classpulse_lessons SET
       title             = COALESCE($2, title),
       description       = COALESCE($3, description),
       subject           = COALESCE($4, subject),
       grade_level       = COALESCE($5, grade_level),
       class_id          = COALESCE($6, class_id),
       estimated_minutes = COALESCE($7, estimated_minutes),
       tags              = COALESCE($8, tags),
       folder            = COALESCE($9, folder),
       status            = COALESCE($10, status)
     WHERE id = $1
     RETURNING *`,
    [lessonId, title || null, description || null, subject || null, grade_level || null,
     class_id || null, estimated_minutes || null, tags || null, folder || null, status || null]
  );
  res.json(lesson);
});

// ---------------------------------------------------------------------------
// Lessons — Archive
// ---------------------------------------------------------------------------

router.put('/lessons/:lessonId/archive', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { rows: [lesson] } = await query(
    `UPDATE classpulse_lessons SET status = 'archived' WHERE id = $1 RETURNING *`,
    [lessonId]
  );
  res.json(lesson);
});

// ---------------------------------------------------------------------------
// Lessons — Delete
// ---------------------------------------------------------------------------

router.delete('/lessons/:lessonId', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await query(`DELETE FROM classpulse_lessons WHERE id = $1`, [lessonId]);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Lessons — Duplicate
// ---------------------------------------------------------------------------

router.post('/lessons/:lessonId/duplicate', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;

  const original = await getLessonDetail(lessonId);
  if (!original) return res.status(404).json({ error: 'Lesson not found' });

  // Can duplicate own lessons or shared lessons
  if (!isAdminPlus(role) && original.teacher_id !== userId) {
    const { rows } = await query(
      `SELECT 1 FROM classpulse_lesson_shares
       WHERE lesson_id = $1 AND (shared_with = $2 OR shared_with IS NULL)`,
      [lessonId, userId]
    );
    if (!rows.length) return res.status(403).json({ error: 'Forbidden' });
  }

  const newLesson = await withTransaction(async client => {
    const { rows: [lesson] } = await client.query(
      `INSERT INTO classpulse_lessons
         (teacher_id, title, description, subject, grade_level, class_id, estimated_minutes, tags, folder, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft')
       RETURNING *`,
      [userId, `${original.title} (copy)`, original.description, original.subject,
       original.grade_level, original.class_id, original.estimated_minutes,
       original.tags, original.folder]
    );

    for (const page of original.pages) {
      const { rows: [newPage] } = await client.query(
        `INSERT INTO classpulse_pages
           (lesson_id, position, content_type, title, body, teacher_notes, student_instructions)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [lesson.id, page.position, page.content_type, page.title,
         page.body, page.teacher_notes, page.student_instructions]
      );

      for (const q of page.questions) {
        const { rows: [newQ] } = await client.query(
          `INSERT INTO classpulse_questions (page_id, question_type, prompt, settings, position)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [newPage.id, q.question_type, q.prompt, q.settings, q.position]
        );

        for (const o of q.options) {
          await client.query(
            `INSERT INTO classpulse_question_options (question_id, text, is_correct, position)
             VALUES ($1,$2,$3,$4)`,
            [newQ.id, o.text, o.is_correct, o.position]
          );
        }
      }
    }

    return lesson;
  });

  res.status(201).json(await getLessonDetail(newLesson.id));
});

// ---------------------------------------------------------------------------
// Lessons — Share
// ---------------------------------------------------------------------------

router.post('/lessons/:lessonId/share', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;
  const { user_id: sharedWith = null } = req.body; // null = school-wide

  const { rows: policyRows } = await query(`SELECT value FROM settings WHERE key = 'classpulse_lesson_sharing'`);
  if ((policyRows[0]?.value || 'school_wide') === 'own_only') {
    return res.status(403).json({ error: 'Lesson sharing is disabled by your district administrator' });
  }

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await query(
    `INSERT INTO classpulse_lesson_shares (lesson_id, shared_by, shared_with)
     VALUES ($1,$2,$3)
     ON CONFLICT (lesson_id, shared_with) DO NOTHING`,
    [lessonId, userId, sharedWith]
  );
  res.status(201).json({ ok: true });
});

router.delete('/lessons/:lessonId/share', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;
  const { user_id: sharedWith = null } = req.body;

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await query(
    `DELETE FROM classpulse_lesson_shares
     WHERE lesson_id = $1 AND (shared_with = $2 OR ($2::uuid IS NULL AND shared_with IS NULL))`,
    [lessonId, sharedWith]
  );
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Pages — Create
// ---------------------------------------------------------------------------

router.post('/lessons/:lessonId/pages', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { content_type = 'content', title, body, teacher_notes, student_instructions } = req.body;

  // Append after the current last page
  const { rows: [{ max_pos }] } = await query(
    `SELECT COALESCE(MAX(position), 0) AS max_pos FROM classpulse_pages WHERE lesson_id = $1`,
    [lessonId]
  );

  const { rows: [page] } = await query(
    `INSERT INTO classpulse_pages
       (lesson_id, position, content_type, title, body, teacher_notes, student_instructions)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [lessonId, max_pos + 1, content_type, title || null, body || null,
     teacher_notes || null, student_instructions || null]
  );
  res.status(201).json({ ...page, questions: [] });
});

// ---------------------------------------------------------------------------
// Pages — Reorder  (MUST be registered before /:pageId to avoid shadowing)
// ---------------------------------------------------------------------------

const MAX_PAGES = 200;

router.put('/lessons/:lessonId/pages/reorder', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!Array.isArray(req.body.order)) return res.status(400).json({ error: 'order must be an array' });

  // Cap to prevent unbounded loops
  const order = req.body.order.slice(0, MAX_PAGES);

  await withTransaction(async client => {
    // Phase 1: shift all affected pages to large temporary positions to avoid
    // UNIQUE(lesson_id, position) conflicts while swapping (e.g. page A=1→2
    // when page B is already at 2 would violate the constraint mid-update).
    await client.query(
      `UPDATE classpulse_pages SET position = position + 1000000
       WHERE lesson_id = $1 AND id = ANY($2::uuid[])`,
      [lessonId, order]
    );
    // Phase 2: assign final 1-based positions
    for (let i = 0; i < order.length; i++) {
      await client.query(
        `UPDATE classpulse_pages SET position = $1 WHERE id = $2 AND lesson_id = $3`,
        [i + 1, order[i], lessonId]
      );
    }
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Pages — Update
// ---------------------------------------------------------------------------

router.put('/lessons/:lessonId/pages/:pageId', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId, pageId } = req.params;

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { content_type, title, body, teacher_notes, student_instructions } = req.body;

  const { rows: [page] } = await query(
    `UPDATE classpulse_pages SET
       content_type         = COALESCE($3, content_type),
       title                = COALESCE($4, title),
       body                 = COALESCE($5, body),
       teacher_notes        = COALESCE($6, teacher_notes),
       student_instructions = COALESCE($7, student_instructions)
     WHERE id = $1 AND lesson_id = $2
     RETURNING *`,
    [pageId, lessonId, content_type || null, title || null, body || null,
     teacher_notes || null, student_instructions || null]
  );
  if (!page) return res.status(404).json({ error: 'Page not found' });
  res.json(page);
});

// ---------------------------------------------------------------------------
// Pages — Delete
// ---------------------------------------------------------------------------

router.delete('/lessons/:lessonId/pages/:pageId', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId, pageId } = req.params;

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await withTransaction(async client => {
    const { rows: [deleted] } = await client.query(
      `DELETE FROM classpulse_pages WHERE id = $1 AND lesson_id = $2 RETURNING position`,
      [pageId, lessonId]
    );
    if (!deleted) return;
    // Close the gap in positions
    await client.query(
      `UPDATE classpulse_pages SET position = position - 1
       WHERE lesson_id = $1 AND position > $2`,
      [lessonId, deleted.position]
    );
  });

  res.status(204).end();
});


// ---------------------------------------------------------------------------
// Questions — Create
// ---------------------------------------------------------------------------

router.post('/pages/:pageId/questions', async (req, res) => {
  const { userId, role } = req.user;
  const { pageId } = req.params;

  // Verify the page's lesson is owned by the caller
  const { rows: [page] } = await query(
    `SELECT lesson_id FROM classpulse_pages WHERE id = $1`, [pageId]
  );
  if (!page) return res.status(404).json({ error: 'Page not found' });
  if (!await ownsLesson(page.lesson_id, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { question_type, prompt, settings = {} } = req.body;
  const options = (req.body.options || []).slice(0, MAX_OPTIONS);
  if (!question_type) return res.status(400).json({ error: 'question_type is required' });
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt is required' });

  const { rows: [{ max_pos }] } = await query(
    `SELECT COALESCE(MAX(position), 0) AS max_pos FROM classpulse_questions WHERE page_id = $1`,
    [pageId]
  );

  const question = await withTransaction(async client => {
    const { rows: [q] } = await client.query(
      `INSERT INTO classpulse_questions (page_id, question_type, prompt, settings, position)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [pageId, question_type, prompt.trim(), settings, max_pos + 1]
    );

    const insertedOptions = [];
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      const { rows: [opt] } = await client.query(
        `INSERT INTO classpulse_question_options (question_id, text, is_correct, position)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [q.id, o.text, o.is_correct || false, i + 1]
      );
      insertedOptions.push(opt);
    }

    return { ...q, options: insertedOptions };
  });

  res.status(201).json(question);
});

// ---------------------------------------------------------------------------
// Questions — Update
// ---------------------------------------------------------------------------

router.put('/questions/:questionId', async (req, res) => {
  const { userId, role } = req.user;
  const { questionId } = req.params;

  const { rows: [q] } = await query(
    `SELECT q.*, p.lesson_id FROM classpulse_questions q
     JOIN classpulse_pages p ON p.id = q.page_id
     WHERE q.id = $1`,
    [questionId]
  );
  if (!q) return res.status(404).json({ error: 'Question not found' });
  if (!await ownsLesson(q.lesson_id, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { prompt, settings } = req.body;
  const options = Array.isArray(req.body.options) ? req.body.options.slice(0, MAX_OPTIONS) : null;

  await withTransaction(async client => {
    await client.query(
      `UPDATE classpulse_questions SET
         prompt   = COALESCE($2, prompt),
         settings = COALESCE($3, settings)
       WHERE id = $1`,
      [questionId, prompt || null, settings || null]
    );

    if (options !== null) {
      await client.query(`DELETE FROM classpulse_question_options WHERE question_id = $1`, [questionId]);
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        await client.query(
          `INSERT INTO classpulse_question_options (question_id, text, is_correct, position)
           VALUES ($1,$2,$3,$4)`,
          [questionId, o.text, o.is_correct || false, i + 1]
        );
      }
    }
  });

  const { rows: [updated] } = await query(`SELECT * FROM classpulse_questions WHERE id = $1`, [questionId]);
  const { rows: updatedOptions } = await query(
    `SELECT * FROM classpulse_question_options WHERE question_id = $1 ORDER BY position`, [questionId]
  );
  res.json({ ...updated, options: updatedOptions });
});

// ---------------------------------------------------------------------------
// Questions — Delete
// ---------------------------------------------------------------------------

router.delete('/questions/:questionId', async (req, res) => {
  const { userId, role } = req.user;
  const { questionId } = req.params;

  const { rows: [q] } = await query(
    `SELECT q.*, p.lesson_id FROM classpulse_questions q
     JOIN classpulse_pages p ON p.id = q.page_id
     WHERE q.id = $1`,
    [questionId]
  );
  if (!q) return res.status(404).json({ error: 'Question not found' });
  if (!await ownsLesson(q.lesson_id, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await query(`DELETE FROM classpulse_questions WHERE id = $1`, [questionId]);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Admin-only: list all lessons district-wide
// ---------------------------------------------------------------------------

router.get('/admin/lessons', requireMinRole('admin'), requirePermissionIfAdmin('classpulse'), async (req, res) => {
  const { rows } = await query(
    `SELECT l.*, u.full_name AS teacher_name,
            COUNT(DISTINCT p.id)::int AS page_count
     FROM classpulse_lessons l
     JOIN users u ON u.id = l.teacher_id
     LEFT JOIN classpulse_pages p ON p.lesson_id = l.id
     GROUP BY l.id, u.full_name
     ORDER BY l.updated_at DESC`
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Sessions — Start
// ---------------------------------------------------------------------------

router.post('/sessions/start', async (req, res) => {
  const { userId, role } = req.user;
  const { lesson_id, class_id, mode = 'teacher_paced', classroom_lock_enabled = false } = req.body;

  if (!lesson_id) return res.status(400).json({ error: 'lesson_id is required' });

  // Verify the teacher owns this lesson (or has admin access)
  if (!await ownsLesson(lesson_id, userId, role)) {
    return res.status(403).json({ error: 'You do not own this lesson' });
  }

  // Verify the teacher owns the class they are starting this session for
  if (class_id) {
    const { rows: [cls] } = await query(
      `SELECT 1 FROM classes WHERE id = $1 AND (teacher_id = $2 OR $3)`,
      [class_id, userId, isAdminPlus(role)]
    );
    if (!cls) return res.status(403).json({ error: 'You do not own this class' });
  }

  // Get the first page of the lesson to set as current
  const { rows: [firstPage] } = await query(
    `SELECT id FROM classpulse_pages WHERE lesson_id = $1 ORDER BY position LIMIT 1`,
    [lesson_id]
  );

  const joinCode = await generateUniqueJoinCode();

  const { rows: [session] } = await query(
    `INSERT INTO classpulse_sessions
       (lesson_id, teacher_id, class_id, join_code, mode, classroom_lock_enabled, current_page_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [lesson_id, userId, class_id || null, joinCode, mode, classroom_lock_enabled, firstPage?.id || null]
  );

  // Track active session for this class in Redis so the socket handler can
  // bridge off-task activity events to the ClassPulse dashboard
  if (class_id) {
    await redis.set(`classpulse:class:${class_id}:session`, session.id, 'EX', 28800);
  }

  res.status(201).json(session);
});

// ---------------------------------------------------------------------------
// Sessions — Get / Dashboard / Navigation
// ---------------------------------------------------------------------------

// List the caller's own sessions (newest first) — this is how a teacher gets
// back to a live session after closing the tab, and how they reach stored
// results after a session ends. Admins with the classpulse permission see all.
router.get('/sessions', async (req, res) => {
  const { userId, role } = req.user;
  const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const isAdmin = ['admin', 'superadmin'].includes(role);

  const { rows } = await query(
    `SELECT s.id, s.join_code, s.mode, s.status, s.started_at, s.ended_at, s.class_id,
            l.title AS lesson_title, c.name AS class_name,
            (SELECT COUNT(*)::int FROM classpulse_session_students
             WHERE session_id = s.id) AS student_count,
            (SELECT COUNT(*)::int FROM classpulse_responses
             WHERE session_id = s.id) AS response_count
     FROM classpulse_sessions s
     LEFT JOIN classpulse_lessons l ON l.id = s.lesson_id
     LEFT JOIN classes c ON c.id = s.class_id
     WHERE s.teacher_id = $1 OR $2
     ORDER BY s.started_at DESC
     LIMIT $3 OFFSET $4`,
    [userId, isAdmin, limit, offset]
  );
  res.json(rows);
});

router.get('/sessions/:id', async (req, res) => {
  const { userId, role } = req.user;
  const { id } = req.params;

  const { rows: [session] } = await query(
    `SELECT s.*, l.title AS lesson_title, c.name AS class_name,
            (SELECT COUNT(*)::int FROM classpulse_session_students
             WHERE session_id = s.id AND status = 'active') AS student_count
     FROM classpulse_sessions s
     LEFT JOIN classpulse_lessons l ON l.id = s.lesson_id
     LEFT JOIN classes c ON c.id = s.class_id
     WHERE s.id = $1 AND (s.teacher_id = $2 OR $3)`,
    [id, userId, ['admin','superadmin'].includes(role)]
  );
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

router.get('/sessions/:id/dashboard', async (req, res) => {
  const { userId, role } = req.user;
  const { id: sessionId } = req.params;

  const { rows: [session] } = await query(
    `SELECT s.*, l.title AS lesson_title, c.name AS class_name
     FROM classpulse_sessions s
     LEFT JOIN classpulse_lessons l ON l.id = s.lesson_id
     LEFT JOIN classes c ON c.id = s.class_id
     WHERE s.id = $1 AND (s.teacher_id = $2 OR $3)`,
    [sessionId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const [{ rows: students }, { rows: pages }] = await Promise.all([
    query(
      `SELECT ss.student_id, ss.joined_at, ss.last_seen_at, ss.status, ss.current_page_id,
              u.full_name, u.email
       FROM classpulse_session_students ss
       JOIN users u ON u.id = ss.student_id
       WHERE ss.session_id = $1
       ORDER BY u.full_name`,
      [sessionId]
    ),
    query(
      `SELECT p.id, p.position, p.title, p.content_type, p.body, p.teacher_notes, p.image_url,
              COUNT(DISTINCT q.id)::int AS question_count
       FROM classpulse_pages p
       LEFT JOIN classpulse_questions q ON q.page_id = p.id
       WHERE p.lesson_id = $1
       GROUP BY p.id ORDER BY p.position`,
      [session.lesson_id]
    ),
  ]);

  // Aggregate responses for the current page's questions
  let questionAggregates = [];
  if (session.current_page_id) {
    const { rows: questions } = await query(
      `SELECT id FROM classpulse_questions WHERE page_id = $1 ORDER BY position`,
      [session.current_page_id]
    );
    questionAggregates = await Promise.all(
      questions.map(q => aggregateResponses(sessionId, q.id))
    );
  }

  // Pulse score — read focus data from Redis
  const focusRaw = await redis.hgetall(`classpulse:session:${sessionId}:offtask`).catch(() => null);
  const focusData = {};
  if (focusRaw) {
    for (const [sid, ts] of Object.entries(focusRaw)) {
      focusData[sid] = parseInt(ts, 10);
    }
  }
  const pulseScore = await calcPulseScore(sessionId, focusData);

  res.json({
    session,
    students,
    pages,
    questionAggregates,
    pulseScore,
  });
});

// Navigate to next page (teacher-paced)
router.post('/sessions/:id/next', async (req, res) => {
  const { userId, role } = req.user;
  const { id: sessionId } = req.params;

  const { rows: [session] } = await query(
    `SELECT s.*, p.position AS current_position
     FROM classpulse_sessions s
     LEFT JOIN classpulse_pages p ON p.id = s.current_page_id
     WHERE s.id = $1 AND s.status = 'active' AND (s.teacher_id = $2 OR $3)`,
    [sessionId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { rows: [nextPage] } = await query(
    `SELECT id, position FROM classpulse_pages
     WHERE lesson_id = $1 AND position > $2
     ORDER BY position LIMIT 1`,
    [session.lesson_id, session.current_position || 0]
  );

  if (!nextPage) return res.json({ at_end: true, current_page_id: session.current_page_id });

  await query(
    `UPDATE classpulse_sessions SET current_page_id = $1 WHERE id = $2`,
    [nextPage.id, sessionId]
  );

  const pageDetail = await getPageForBroadcast(nextPage.id);
  events.emit('classpulse:page_changed', { sessionId, page: pageDetail, classId: session.class_id });

  res.json({ current_page_id: nextPage.id, page: pageDetail });
});

// Navigate to previous page
router.post('/sessions/:id/previous', async (req, res) => {
  const { userId, role } = req.user;
  const { id: sessionId } = req.params;

  const { rows: [session] } = await query(
    `SELECT s.*, p.position AS current_position
     FROM classpulse_sessions s
     LEFT JOIN classpulse_pages p ON p.id = s.current_page_id
     WHERE s.id = $1 AND s.status = 'active' AND (s.teacher_id = $2 OR $3)`,
    [sessionId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { rows: [prevPage] } = await query(
    `SELECT id, position FROM classpulse_pages
     WHERE lesson_id = $1 AND position < $2
     ORDER BY position DESC LIMIT 1`,
    [session.lesson_id, session.current_position || 1]
  );

  if (!prevPage) return res.json({ at_start: true, current_page_id: session.current_page_id });

  await query(
    `UPDATE classpulse_sessions SET current_page_id = $1 WHERE id = $2`,
    [prevPage.id, sessionId]
  );

  const pageDetail = await getPageForBroadcast(prevPage.id);
  events.emit('classpulse:page_changed', { sessionId, page: pageDetail, classId: session.class_id });

  res.json({ current_page_id: prevPage.id, page: pageDetail });
});

// Jump to a specific page
router.post('/sessions/:id/goto', async (req, res) => {
  const { userId, role } = req.user;
  const { id: sessionId } = req.params;
  const { page_id } = req.body;

  if (!page_id) return res.status(400).json({ error: 'page_id is required' });

  const { rows: [session] } = await query(
    `SELECT s.* FROM classpulse_sessions s
     WHERE s.id = $1 AND s.status = 'active' AND (s.teacher_id = $2 OR $3)`,
    [sessionId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Verify the page belongs to this lesson
  const { rows: [page] } = await query(
    `SELECT id FROM classpulse_pages WHERE id = $1 AND lesson_id = $2`,
    [page_id, session.lesson_id]
  );
  if (!page) return res.status(400).json({ error: 'Page not found in this lesson' });

  await query(
    `UPDATE classpulse_sessions SET current_page_id = $1 WHERE id = $2`,
    [page_id, sessionId]
  );

  const pageDetail = await getPageForBroadcast(page_id);
  events.emit('classpulse:page_changed', { sessionId, page: pageDetail, classId: session.class_id });

  res.json({ current_page_id: page_id, page: pageDetail });
});

// End session
router.post('/sessions/:id/end', async (req, res) => {
  const { userId, role } = req.user;
  const { id: sessionId } = req.params;
  const { teacher_comments } = req.body;

  const { rows: [session] } = await query(
    `UPDATE classpulse_sessions
     SET status = 'ended', ended_at = now(),
         teacher_comments = COALESCE($3, teacher_comments)
     WHERE id = $1 AND status = 'active' AND (teacher_id = $2 OR $4)
     RETURNING *`,
    [sessionId, userId, teacher_comments || null, ['admin','superadmin'].includes(role)]
  );
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  // Clear the class→session Redis mapping
  if (session.class_id) {
    await redis.del(`classpulse:class:${session.class_id}:session`).catch(() => {});
  }
  await redis.del(`classpulse:session:${sessionId}:offtask`).catch(() => {});

  // Release the focus lock — without this, students who were locked to the
  // session would stay locked after the teacher ends it.
  if (session.classroom_lock_enabled) {
    const { rows: lockedStudents } = await query(
      `SELECT student_id FROM classpulse_session_students WHERE session_id = $1`,
      [sessionId]
    );
    let targets = lockedStudents.map(s => s.student_id);
    if (session.class_id) {
      const { rows: roster } = await query(
        `SELECT student_id FROM class_members WHERE class_id = $1`,
        [session.class_id]
      );
      targets = [...new Set([...targets, ...roster.map(r => r.student_id)])];
    }
    for (const student_id of targets) {
      events.emit('teacher:unlock_request', { studentId: student_id });
    }
  }

  events.emit('classpulse:session_ended', { sessionId, classId: session.class_id });

  res.json(session);
});

// Session report
router.get('/sessions/:id/report', async (req, res) => {
  const { userId, role } = req.user;
  const { id: sessionId } = req.params;

  const { rows: [session] } = await query(
    `SELECT 1 FROM classpulse_sessions WHERE id = $1 AND (teacher_id = $2 OR $3)`,
    [sessionId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const report = await buildSessionReport(sessionId);
  res.json(report);
});

// ---------------------------------------------------------------------------
// Sessions — Classroom Lock Integration
// ---------------------------------------------------------------------------

// Engage ClassPulse focus lock — redirects all joined students to the join page
// and keeps them there. Uses the existing lock:engage socket event mechanism
// rather than creating lockdown_sessions records (lighter-weight focus mode).
router.post('/sessions/:id/lock', async (req, res) => {
  const { userId, role } = req.user;
  const { id: sessionId } = req.params;

  const { rows: [session] } = await query(
    `UPDATE classpulse_sessions SET classroom_lock_enabled = true
     WHERE id = $1 AND status = 'active' AND (teacher_id = $2 OR $3)
     RETURNING join_code, class_id`,
    [sessionId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  const { rows: students } = await query(
    `SELECT student_id FROM classpulse_session_students
     WHERE session_id = $1 AND status = 'active'`,
    [sessionId]
  );

  // Lock the whole class roster when the session is tied to a class (so the
  // focus lock reaches students who haven't opened the join page yet), or
  // just the joined students for an open session. allowPulse tells the
  // extension to open /pulse/<code> and exempt it from the lock overlay —
  // without that exemption the lock would block the very page students
  // answer on.
  let targets = students.map(s => s.student_id);
  if (session.class_id) {
    const { rows: roster } = await query(
      `SELECT student_id FROM class_members WHERE class_id = $1`,
      [session.class_id]
    );
    targets = [...new Set([...targets, ...roster.map(r => r.student_id)])];
  }

  for (const student_id of targets) {
    events.emit('teacher:lock_request', {
      studentId:  student_id,
      message:    `ClassPulse session in progress — code: ${session.join_code}`,
      targetPath: `/pulse/${session.join_code}`,
      allowPulse: true,
    });
  }

  events.emit('classpulse:lock_changed', { sessionId, locked: true, joinCode: session.join_code });
  res.json({ ok: true, locked_count: targets.length });
});

// Release ClassPulse focus lock
router.post('/sessions/:id/unlock', async (req, res) => {
  const { userId, role } = req.user;
  const { id: sessionId } = req.params;

  const { rows: [session] } = await query(
    `UPDATE classpulse_sessions SET classroom_lock_enabled = false
     WHERE id = $1 AND status = 'active' AND (teacher_id = $2 OR $3)
     RETURNING class_id`,
    [sessionId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  // Mirror the lock route's targeting: the lock reaches the whole class
  // roster (not just joined students), so the release has to as well.
  const { rows: students } = await query(
    `SELECT student_id FROM classpulse_session_students WHERE session_id = $1`,
    [sessionId]
  );
  let targets = students.map(s => s.student_id);
  if (session.class_id) {
    const { rows: roster } = await query(
      `SELECT student_id FROM class_members WHERE class_id = $1`,
      [session.class_id]
    );
    targets = [...new Set([...targets, ...roster.map(r => r.student_id)])];
  }

  for (const student_id of targets) {
    events.emit('teacher:unlock_request', { studentId: student_id });
  }

  events.emit('classpulse:lock_changed', { sessionId, locked: false });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Response Moderation
// ---------------------------------------------------------------------------

router.post('/responses/:responseId/flag', async (req, res) => {
  const { userId, role } = req.user;
  const { responseId } = req.params;
  const { reason } = req.body;

  // Verify teacher owns the session this response belongs to
  const { rows: [resp] } = await query(
    `SELECT r.id, r.session_id FROM classpulse_responses r
     JOIN classpulse_sessions s ON s.id = r.session_id
     WHERE r.id = $1 AND (s.teacher_id = $2 OR $3)`,
    [responseId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!resp) return res.status(404).json({ error: 'Response not found' });

  await withTransaction(async client => {
    await client.query(
      `UPDATE classpulse_responses SET is_flagged = true WHERE id = $1`, [responseId]
    );
    await client.query(
      `INSERT INTO classpulse_flags (response_id, teacher_id, reason) VALUES ($1,$2,$3)`,
      [responseId, userId, reason || null]
    );
  });

  res.json({ ok: true });
});

router.delete('/responses/:responseId/flag', async (req, res) => {
  const { userId, role } = req.user;
  const { responseId } = req.params;

  const { rows: [resp] } = await query(
    `SELECT r.id FROM classpulse_responses r
     JOIN classpulse_sessions s ON s.id = r.session_id
     WHERE r.id = $1 AND (s.teacher_id = $2 OR $3)`,
    [responseId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!resp) return res.status(404).json({ error: 'Response not found' });

  await query(`UPDATE classpulse_responses SET is_flagged = false WHERE id = $1`, [responseId]);
  await query(`DELETE FROM classpulse_flags WHERE response_id = $1`, [responseId]);

  res.status(204).end();
});

router.post('/responses/:responseId/hide', async (req, res) => {
  const { userId, role } = req.user;
  const { responseId } = req.params;

  const { rows: [resp] } = await query(
    `SELECT r.id, r.is_hidden FROM classpulse_responses r
     JOIN classpulse_sessions s ON s.id = r.session_id
     WHERE r.id = $1 AND (s.teacher_id = $2 OR $3)`,
    [responseId, userId, ['admin','superadmin'].includes(role)]
  );
  if (!resp) return res.status(404).json({ error: 'Response not found' });

  await query(
    `UPDATE classpulse_responses SET is_hidden = NOT is_hidden WHERE id = $1`,
    [responseId]
  );
  res.json({ is_hidden: !resp.is_hidden });
});

// ---------------------------------------------------------------------------
// Helper: fetch a page with student-safe question data for socket broadcast
// ---------------------------------------------------------------------------

async function getPageForBroadcast(pageId) {
  const { rows: [page] } = await query(
    `SELECT id, position, content_type, title, body, student_instructions, image_url
     FROM classpulse_pages WHERE id = $1`,
    [pageId]
  );
  if (!page) return null;

  const { rows: questions } = await query(
    `SELECT id, question_type, prompt, settings, position
     FROM classpulse_questions WHERE page_id = $1 ORDER BY position`,
    [pageId]
  );
  const { rows: options } = await query(
    `SELECT o.id, o.text, o.position, o.question_id
     FROM classpulse_question_options o
     WHERE o.question_id = ANY($1::uuid[]) ORDER BY o.question_id, o.position`,
    [questions.map(q => q.id)]
  );
  const optsByQ = {};
  for (const o of options) {
    if (!optsByQ[o.question_id]) optsByQ[o.question_id] = [];
    optsByQ[o.question_id].push({ id: o.id, text: o.text, position: o.position });
  }
  return {
    ...page,
    questions: questions.map(q => ({ ...q, options: optsByQ[q.id] || [] })),
  };
}

module.exports = router;
