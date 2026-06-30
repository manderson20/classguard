const { Router } = require('express');
const { query, withTransaction } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermissionIfAdmin } = require('../middleware/permissions');

// Hard cap on options per question — prevents loop-bound injection from
// unbounded user-supplied arrays and keeps the DB sane.
const MAX_OPTIONS = 26;

const router = Router();

// All ClassPulse routes require at minimum a teacher login.
// Admin-only config actions additionally gate on 'classpulse' permission.
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

  const { rows } = await query(
    `SELECT l.*,
            u.full_name AS teacher_name,
            COUNT(DISTINCT p.id)::int AS page_count,
            COUNT(DISTINCT q.id)::int AS question_count,
            EXISTS (
              SELECT 1 FROM classpulse_lesson_shares s
              WHERE s.lesson_id = l.id AND (s.shared_with = $1 OR s.shared_with IS NULL)
            ) AS is_shared_with_me
     FROM classpulse_lessons l
     JOIN users u ON u.id = l.teacher_id
     LEFT JOIN classpulse_pages p ON p.lesson_id = l.id
     LEFT JOIN classpulse_questions q ON q.page_id = p.id
     WHERE (
       l.teacher_id = $1
       OR EXISTS (
         SELECT 1 FROM classpulse_lesson_shares s
         WHERE s.lesson_id = l.id AND (s.shared_with = $1 OR s.shared_with IS NULL)
       )
       OR $2
     )
     AND ($3::text IS NULL OR l.title ILIKE '%' || $3 || '%' OR l.description ILIKE '%' || $3 || '%')
     AND ($4::text IS NULL OR $4 = ANY(l.tags))
     AND ($5::text IS NULL OR l.folder = $5)
     AND ($6::text IS NULL OR l.status = $6)
     GROUP BY l.id, u.full_name
     ORDER BY l.updated_at DESC`,
    [userId, adminPlus, search || null, tag || null, folder || null, status || null]
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
// Pages — Reorder
// ---------------------------------------------------------------------------

router.put('/lessons/:lessonId/pages/reorder', async (req, res) => {
  const { userId, role } = req.user;
  const { lessonId } = req.params;
  const { order } = req.body; // array of page UUIDs in desired order

  if (!await ownsLesson(lessonId, userId, role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });

  await withTransaction(async client => {
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

router.get('/admin/lessons', requirePermissionIfAdmin('classpulse'), async (req, res) => {
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

module.exports = router;
