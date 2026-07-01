const { Router }          = require('express');
const fs                  = require('fs');
const path                = require('path');
const multer              = require('multer');
const { query }           = require('../db');
const { authenticate }    = require('../middleware/auth');
const { requireMinRole }  = require('../middleware/roles');
const { requirePermission } = require('../middleware/permissions');
const { teacherOwnsStudent } = require('../services/teacherRoster');
const { hasPermission }   = require('../services/permissions');
const events              = require('../events');

const router = Router();
router.use(authenticate);

const MAX_BODY_LENGTH = 2000;

// File distribution — same date-sharded on-disk storage pattern as
// routes/extension.js's screenshot storage (SCREENSHOT_DIR), own dedicated
// volume (chat-files, docker-compose.yml) rather than reusing the
// screenshots one, since these are two very different privacy/retention
// categories (safety-evidence spot-checks vs. a teacher sharing a
// worksheet) that shouldn't share a directory.
const CHAT_FILES_DIR = process.env.CHAT_FILES_DIR || path.join(__dirname, '../../chat-files');
fs.mkdirSync(CHAT_FILES_DIR, { recursive: true });
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

async function isThreadMember(threadId, userId) {
  const { rows } = await query(
    'SELECT 1 FROM chat_thread_members WHERE thread_id = $1 AND user_id = $2',
    [threadId, userId]
  );
  return rows.length > 0;
}

// A given teacher+student pair always maps to the same 'direct' thread,
// reused across sends — two different teachers messaging the same student
// get two separate threads, since each thread is really "this teacher and
// this student", not "this student's inbox".
async function findOrCreateDirectThread(teacherId, studentId, classId) {
  const { rows: existing } = await query(
    `SELECT t.id FROM chat_threads t
     WHERE t.type = 'direct'
       AND EXISTS (SELECT 1 FROM chat_thread_members WHERE thread_id = t.id AND user_id = $1)
       AND EXISTS (SELECT 1 FROM chat_thread_members WHERE thread_id = t.id AND user_id = $2)
       AND (SELECT COUNT(*) FROM chat_thread_members WHERE thread_id = t.id) = 2
     LIMIT 1`,
    [teacherId, studentId]
  );
  if (existing[0]) return existing[0].id;

  const { rows: created } = await query(
    `INSERT INTO chat_threads (type, class_id, created_by) VALUES ('direct', $1, $2) RETURNING id`,
    [classId || null, teacherId]
  );
  const threadId = created[0].id;
  await query(
    `INSERT INTO chat_thread_members (thread_id, user_id, role) VALUES ($1,$2,'teacher'), ($1,$3,'student')`,
    [threadId, teacherId, studentId]
  );
  return threadId;
}

async function notifyNewMessage(threadId, message, excludeUserId) {
  const { rows: members } = await query(
    'SELECT user_id FROM chat_thread_members WHERE thread_id = $1 AND user_id != $2',
    [threadId, excludeUserId]
  );
  events.emit('chat:new_message', {
    threadId, message,
    recipientIds: members.map(m => m.user_id),
  });
}

// ---------------------------------------------------------------------------
// GET /threads — every thread the caller belongs to, with last message
// preview and unread count.
// ---------------------------------------------------------------------------
router.get('/threads', async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.type, t.name, t.class_id, t.created_at, t.archived_at,
            m.last_read_at,
            (SELECT body FROM chat_messages
              WHERE thread_id = t.id AND deleted_at IS NULL
              ORDER BY created_at DESC LIMIT 1)            AS last_message,
            (SELECT created_at FROM chat_messages
              WHERE thread_id = t.id AND deleted_at IS NULL
              ORDER BY created_at DESC LIMIT 1)            AS last_message_at,
            (SELECT COUNT(*) FROM chat_messages
              WHERE thread_id = t.id AND deleted_at IS NULL
                AND sender_id != $1 AND created_at > m.last_read_at)::int AS unread_count
     FROM chat_thread_members m
     JOIN chat_threads t ON t.id = m.thread_id
     WHERE m.user_id = $1
     ORDER BY last_message_at DESC NULLS LAST, t.created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// GET /threads/:id — thread detail + members
// ---------------------------------------------------------------------------
router.get('/threads/:id', async (req, res) => {
  if (!(await isThreadMember(req.params.id, req.user.userId))) {
    return res.status(403).json({ error: 'Not a member of this thread' });
  }
  const { rows: thread } = await query('SELECT * FROM chat_threads WHERE id = $1', [req.params.id]);
  if (!thread[0]) return res.status(404).json({ error: 'Thread not found' });

  const { rows: members } = await query(
    `SELECT u.id, u.full_name, u.email, m.role
     FROM chat_thread_members m JOIN users u ON u.id = m.user_id
     WHERE m.thread_id = $1`,
    [req.params.id]
  );
  res.json({ ...thread[0], members });
});

// ---------------------------------------------------------------------------
// POST /threads  { student_ids: [...], type: 'direct'|'group', name?, class_id? }
// ---------------------------------------------------------------------------
router.post('/threads', requireMinRole('teacher'), async (req, res) => {
  const { student_ids, type, name, class_id } = req.body;
  if (!Array.isArray(student_ids) || !student_ids.length) {
    return res.status(400).json({ error: 'student_ids required' });
  }
  if (!['direct', 'group'].includes(type)) {
    return res.status(400).json({ error: "type must be 'direct' or 'group'" });
  }
  if (type === 'direct' && student_ids.length !== 1) {
    return res.status(400).json({ error: 'direct threads take exactly one student_id' });
  }

  const teacherId = req.user.userId;
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    for (const sid of student_ids) {
      if (!(await teacherOwnsStudent(teacherId, sid))) {
        return res.status(403).json({ error: `Student ${sid} is not on one of your rosters` });
      }
    }
  }

  if (type === 'direct') {
    const threadId = await findOrCreateDirectThread(teacherId, student_ids[0], class_id);
    const { rows } = await query('SELECT * FROM chat_threads WHERE id = $1', [threadId]);
    return res.status(201).json(rows[0]);
  }

  const { rows: created } = await query(
    `INSERT INTO chat_threads (type, name, class_id, created_by) VALUES ('group',$1,$2,$3) RETURNING *`,
    [name || null, class_id || null, teacherId]
  );
  const threadId = created[0].id;
  await query(
    `INSERT INTO chat_thread_members (thread_id, user_id, role) VALUES ($1,$2,'teacher')`,
    [threadId, teacherId]
  );
  for (const sid of student_ids) {
    await query(
      `INSERT INTO chat_thread_members (thread_id, user_id, role) VALUES ($1,$2,'student') ON CONFLICT DO NOTHING`,
      [threadId, sid]
    );
  }
  res.status(201).json(created[0]);
});

// ---------------------------------------------------------------------------
// POST /broadcast  { student_ids: [...], body, class_id? }
// Finds-or-creates one direct thread per recipient — same message, no
// shared visibility between recipients.
// ---------------------------------------------------------------------------
router.post('/broadcast', requireMinRole('teacher'), async (req, res) => {
  const { student_ids, body, class_id } = req.body;
  if (!Array.isArray(student_ids) || !student_ids.length) {
    return res.status(400).json({ error: 'student_ids required' });
  }
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  if (body.length > MAX_BODY_LENGTH) return res.status(400).json({ error: 'message too long' });

  const teacherId = req.user.userId;
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    for (const sid of student_ids) {
      if (!(await teacherOwnsStudent(teacherId, sid))) {
        return res.status(403).json({ error: `Student ${sid} is not on one of your rosters` });
      }
    }
  }

  const threadIds = [];
  for (const sid of student_ids) {
    const threadId = await findOrCreateDirectThread(teacherId, sid, class_id);
    const { rows: msg } = await query(
      `INSERT INTO chat_messages (thread_id, sender_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [threadId, teacherId, body]
    );
    await query(
      'UPDATE chat_thread_members SET last_read_at = NOW() WHERE thread_id = $1 AND user_id = $2',
      [threadId, teacherId]
    );
    await notifyNewMessage(threadId, msg[0], teacherId);
    threadIds.push(threadId);
  }
  res.status(201).json({ thread_ids: threadIds });
});

// ---------------------------------------------------------------------------
// GET /threads/:id/messages — membership-checked. Soft-deleted messages are
// returned with their body removed, not hidden entirely, so the thread
// doesn't silently lose a turn in the conversation.
// ---------------------------------------------------------------------------
router.get('/threads/:id/messages', async (req, res) => {
  if (!(await isThreadMember(req.params.id, req.user.userId))) {
    return res.status(403).json({ error: 'Not a member of this thread' });
  }
  const { rows } = await query(
    `SELECT id, sender_id, created_at,
            CASE WHEN deleted_at IS NULL THEN body ELSE NULL END AS body,
            (deleted_at IS NOT NULL) AS deleted,
            CASE WHEN deleted_at IS NULL THEN attachment_name ELSE NULL END AS attachment_name,
            CASE WHEN deleted_at IS NULL THEN attachment_mime ELSE NULL END AS attachment_mime,
            CASE WHEN deleted_at IS NULL THEN attachment_size ELSE NULL END AS attachment_size
     FROM chat_messages WHERE thread_id = $1
     ORDER BY created_at ASC LIMIT 200`,
    [req.params.id]
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /threads/:id/messages  { body }
// ---------------------------------------------------------------------------
router.post('/threads/:id/messages', async (req, res) => {
  if (!(await isThreadMember(req.params.id, req.user.userId))) {
    return res.status(403).json({ error: 'Not a member of this thread' });
  }
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  if (body.length > MAX_BODY_LENGTH) return res.status(400).json({ error: 'message too long' });

  const { rows } = await query(
    `INSERT INTO chat_messages (thread_id, sender_id, body) VALUES ($1,$2,$3) RETURNING *`,
    [req.params.id, req.user.userId, body]
  );
  await query(
    'UPDATE chat_thread_members SET last_read_at = NOW() WHERE thread_id = $1 AND user_id = $2',
    [req.params.id, req.user.userId]
  );
  await notifyNewMessage(req.params.id, rows[0], req.user.userId);
  res.status(201).json(rows[0]);
});

// ---------------------------------------------------------------------------
// POST /threads/:id/messages/attachment  multipart: file, body? (caption)
// File distribution — any thread member can attach a file, not just
// teachers, matching the existing symmetric membership-check pattern every
// other message route already uses (a student replying with a file, e.g.
// turning in work, reuses this same endpoint rather than needing a second
// teacher-only one).
// ---------------------------------------------------------------------------
router.post('/threads/:id/messages/attachment', upload.single('file'), async (req, res) => {
  if (!(await isThreadMember(req.params.id, req.user.userId))) {
    return res.status(403).json({ error: 'Not a member of this thread' });
  }
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const body = (req.body.body || '').trim() || null;
  if (body && body.length > MAX_BODY_LENGTH) return res.status(400).json({ error: 'caption too long' });

  // Date-sharded directory, same layout as extension.js's screenshot storage.
  const now     = new Date();
  const dateDir = path.join(CHAT_FILES_DIR,
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dateDir, { recursive: true });

  const safeExt  = path.extname(req.file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
  const filename = `${Date.now()}-${req.user.userId.slice(0, 8)}${safeExt}`;
  const filePath = path.join(dateDir, filename);
  const relPath  = path.relative(CHAT_FILES_DIR, filePath);
  fs.writeFileSync(filePath, req.file.buffer);

  const { rows } = await query(
    `INSERT INTO chat_messages (thread_id, sender_id, body, attachment_path, attachment_name, attachment_mime, attachment_size)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, thread_id, sender_id, body, created_at, attachment_name, attachment_mime, attachment_size`,
    [req.params.id, req.user.userId, body, relPath,
     req.file.originalname.slice(0, 255), req.file.mimetype, req.file.size]
  );
  await query(
    'UPDATE chat_thread_members SET last_read_at = NOW() WHERE thread_id = $1 AND user_id = $2',
    [req.params.id, req.user.userId]
  );
  // rows[0] deliberately omits attachment_path (an internal server file
  // path) -- the RETURNING list above already excludes it, unlike the
  // plain-text POST /messages route above which returns the full row.
  await notifyNewMessage(req.params.id, rows[0], req.user.userId);
  res.status(201).json(rows[0]);
});

// ---------------------------------------------------------------------------
// GET /messages/:id/attachment — stream the file. Membership-checked via
// the message's own thread, same as every other per-message route — except
// for an admin/superadmin with the chat_audit permission, who can always
// reach it (including a soft-deleted message's attachment), matching
// GET /admin/messages: chat is never really deleted, only hidden from
// participants, and that has to include attachments too, not just text.
// ---------------------------------------------------------------------------
router.get('/messages/:id/attachment', async (req, res) => {
  const { rows } = await query(
    `SELECT thread_id, attachment_path, attachment_name, attachment_mime, deleted_at
     FROM chat_messages WHERE id = $1`,
    [req.params.id]
  );
  const message = rows[0];
  if (!message || !message.attachment_path) return res.status(404).json({ error: 'No attachment' });

  const isAuditor = ['admin', 'superadmin'].includes(req.user.role)
    && await hasPermission(req.user.userId, req.user.role, 'chat_audit').catch(() => false);
  if (!isAuditor) {
    if (message.deleted_at) return res.status(404).json({ error: 'Message deleted' });
    if (!(await isThreadMember(message.thread_id, req.user.userId))) {
      return res.status(403).json({ error: 'Not a member of this thread' });
    }
  }

  const abs = path.join(CHAT_FILES_DIR, message.attachment_path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file not found' });

  res.setHeader('Content-Type', message.attachment_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${(message.attachment_name || 'file').replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(abs).pipe(res);
});

// ---------------------------------------------------------------------------
// PATCH /threads/:id/read — marks the thread read for the caller
// ---------------------------------------------------------------------------
router.patch('/threads/:id/read', async (req, res) => {
  if (!(await isThreadMember(req.params.id, req.user.userId))) {
    return res.status(403).json({ error: 'Not a member of this thread' });
  }
  await query(
    'UPDATE chat_thread_members SET last_read_at = NOW() WHERE thread_id = $1 AND user_id = $2',
    [req.params.id, req.user.userId]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /messages/:id — soft delete only. Sender, any teacher in the
// thread, or admin+ may delete. The row and its original body are never
// removed — see GET /admin/messages.
// ---------------------------------------------------------------------------
router.delete('/messages/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, tm.role AS caller_role_in_thread
     FROM chat_messages m
     LEFT JOIN chat_thread_members tm ON tm.thread_id = m.thread_id AND tm.user_id = $2
     WHERE m.id = $1`,
    [req.params.id, req.user.userId]
  );
  const message = rows[0];
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const isAdmin  = ['admin', 'superadmin'].includes(req.user.role);
  const isSender = message.sender_id === req.user.userId;
  const isTeacherInThread = message.caller_role_in_thread === 'teacher';
  if (!isAdmin && !isSender && !isTeacherInThread) {
    return res.status(403).json({ error: 'Not permitted to delete this message' });
  }

  await query(
    'UPDATE chat_messages SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2',
    [req.user.userId, req.params.id]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /admin/messages — full searchable log across every thread, including
// soft-deleted messages with their original body intact. Admin/superadmin
// only — this is the accountability backstop, not a moderation UI.
// ---------------------------------------------------------------------------
router.get('/admin/messages', requirePermission('chat_audit'), async (req, res) => {
  const { student_id, teacher_id, from, to } = req.query;
  const conditions = [];
  const params = [];

  if (student_id) {
    params.push(student_id);
    conditions.push(`EXISTS (SELECT 1 FROM chat_thread_members WHERE thread_id = m.thread_id AND user_id = $${params.length} AND role = 'student')`);
  }
  if (teacher_id) {
    params.push(teacher_id);
    conditions.push(`EXISTS (SELECT 1 FROM chat_thread_members WHERE thread_id = m.thread_id AND user_id = $${params.length} AND role = 'teacher')`);
  }
  if (from) { params.push(from); conditions.push(`m.created_at >= $${params.length}`); }
  if (to)   { params.push(to);   conditions.push(`m.created_at <= $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT m.id, m.thread_id, m.body, m.created_at, m.deleted_at,
            m.attachment_name, m.attachment_mime, m.attachment_size,
            t.type AS thread_type, t.name AS thread_name,
            sender.full_name AS sender_name, sender.email AS sender_email,
            deleter.full_name AS deleted_by_name
     FROM chat_messages m
     JOIN chat_threads t      ON t.id = m.thread_id
     LEFT JOIN users sender   ON sender.id = m.sender_id
     LEFT JOIN users deleter  ON deleter.id = m.deleted_by
     ${where}
     ORDER BY m.created_at DESC
     LIMIT 500`,
    params
  );
  res.json(rows);
});

module.exports = router;
