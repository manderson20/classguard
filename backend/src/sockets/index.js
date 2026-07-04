const jwt    = require('jsonwebtoken');
const config = require('../config');
const events = require('../events');
const { query } = require('../db');
const redis  = require('../redis');
const { calcPulseScore } = require('../services/classpulse');
const { teacherOwnsStudent } = require('../services/teacherRoster');

const setupSockets = (io) => {
  // Authenticate every socket connection with the same JWT used by the REST API
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.user = jwt.verify(token, config.jwt.secret);
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, role } = socket.user;

    // Every student joins their own private room so we can push policy updates
    socket.join(`student:${userId}`);

    // Every staff member auto-joins this room (no explicit join call needed,
    // unlike class rooms below) so an urgent safety alert reaches whoever's
    // logged in right now, not just whichever class room they happen to
    // have open.
    if (['teacher', 'admin', 'superadmin'].includes(role)) {
      socket.join('role:staff');
    }

    // Infra/ops events (e.g. an HA node auto-promoting its database) are
    // meaningless noise to a teacher or building admin and only meant for
    // whoever can actually act on them.
    if (role === 'superadmin') {
      socket.join('role:superadmin');
    }

    // Teachers and admins join class rooms on demand (called by the dashboard)
    socket.on('join:class', (classId) => {
      if (['teacher','admin','superadmin'].includes(role)) {
        socket.join(`class:${classId}`);
      }
    });

    socket.on('leave:class', (classId) => {
      socket.leave(`class:${classId}`);
    });

    // Live View (routes/liveView.js) — admin+ isn't roster-scoped (any
    // student, same as join:class-style rooms elsewhere trust the HTTP
    // layer), but a teacher joining this room IS scoped here, not just at
    // the HTTP /start route: unlike join:class, actually being in this
    // room lets a socket silently receive another viewer's frames for the
    // same student without ever calling /start themselves, so a teacher
    // must be verified to own the roster before they can even join.
    socket.on('join:liveview', async (studentId) => {
      if (['admin', 'superadmin'].includes(role)) {
        socket.join(`liveview:${studentId}`);
      } else if (role === 'teacher' && await teacherOwnsStudent(userId, studentId)) {
        socket.join(`liveview:${studentId}`);
      }
    });

    socket.on('leave:liveview', (studentId) => {
      socket.leave(`liveview:${studentId}`);
    });

    // ClassPulse: teacher joins their session's live dashboard room
    socket.on('classpulse:join_dashboard', async (sessionId) => {
      if (!['teacher', 'admin', 'superadmin'].includes(role)) return;
      try {
        const { rows: [session] } = await query(
          `SELECT 1 FROM classpulse_sessions WHERE id = $1 AND (teacher_id = $2 OR $3)`,
          [sessionId, userId, ['admin', 'superadmin'].includes(role)]
        );
        if (session) socket.join(`classpulse:dashboard:${sessionId}`);
      } catch {}
    });

    socket.on('classpulse:leave_dashboard', (sessionId) => {
      socket.leave(`classpulse:dashboard:${sessionId}`);
    });

    // ClassPulse: student joins an active session room after calling POST /join/:code
    socket.on('classpulse:join_session', async (sessionId) => {
      try {
        const { rows: [ss] } = await query(
          `SELECT 1 FROM classpulse_session_students WHERE session_id = $1 AND student_id = $2`,
          [sessionId, userId]
        );
        if (!ss) return;
        socket.join(`classpulse:session:${sessionId}`);
        await query(
          `UPDATE classpulse_session_students SET last_seen_at = now(), status = 'active'
           WHERE session_id = $1 AND student_id = $2`,
          [sessionId, userId]
        );
      } catch {}
    });

    // ClassPulse: periodic heartbeat from student tab
    socket.on('classpulse:heartbeat', async ({ sessionId }) => {
      if (!sessionId) return;
      try {
        await query(
          `UPDATE classpulse_session_students SET last_seen_at = now(), status = 'active'
           WHERE session_id = $1 AND student_id = $2`,
          [sessionId, userId]
        );
      } catch {}
    });

    // ClassPulse: student raises a help request — forwarded to teacher dashboard only
    socket.on('classpulse:help_request', async ({ sessionId, message }) => {
      if (!sessionId) return;
      try {
        const { rows: [ss] } = await query(
          `SELECT 1 FROM classpulse_session_students WHERE session_id = $1 AND student_id = $2`,
          [sessionId, userId]
        );
        if (!ss) return;
        const { rows: [student] } = await query(
          `SELECT full_name FROM users WHERE id = $1`, [userId]
        );
        io.to(`classpulse:dashboard:${sessionId}`).emit('classpulse:help_request', {
          studentId:   userId,
          studentName: student?.full_name || 'Student',
          message:     (typeof message === 'string' ? message.slice(0, 500) : null),
          ts:          Date.now(),
        });
      } catch {}
    });

    socket.on('disconnect', () => {});
  });

  // ---------------------------------------------------------------------------
  // Internal event bus → WebSocket bridge
  // ---------------------------------------------------------------------------

  // Policy updates: push to student's extension so it reloads its DNR rules
  events.on('policy:updated', ({ studentId }) => {
    if (studentId) {
      io.to(`student:${studentId}`).emit('policy:updated', { studentId });
    }
  });

  // Student tab activity: forward to all class rooms the student belongs to
  // Uses a Redis-cached class membership list (TTL 5 min) to avoid a DB query
  // on every browser navigation.
  events.on('student:activity', async ({ studentId, url, title, ts, event, action, block_reason }) => {
    if (!studentId) return;

    try {
      const cacheKey = `student:classes:${studentId}`;
      let classIds;

      const cached = await redis.get(cacheKey);
      if (cached) {
        classIds = JSON.parse(cached);
      } else {
        const { rows } = await query(
          'SELECT class_id FROM class_members WHERE student_id = $1',
          [studentId]
        );
        classIds = rows.map(r => r.class_id);
        await redis.set(cacheKey, JSON.stringify(classIds), 'EX', 300);
      }

      const payload = { studentId, url, title, ts, event, action, block_reason };
      for (const classId of classIds) {
        io.to(`class:${classId}`).emit('student:activity', payload);
      }

      // ClassPulse: bridge off-task navigation into active sessions
      for (const classId of classIds) {
        try {
          const sessionId = await redis.get(`classpulse:class:${classId}:session`);
          if (!sessionId) continue;

          const offtaskKey = `classpulse:session:${sessionId}:offtask`;
          const onPulsePage = typeof url === 'string' && url.includes('/pulse/');

          if (onPulsePage) {
            await redis.hdel(offtaskKey, studentId);
          } else {
            await redis.hset(offtaskKey, studentId, String(Date.now()));
            await redis.expire(offtaskKey, 28800);
            io.to(`classpulse:dashboard:${sessionId}`).emit('classpulse:off_task_alert', {
              studentId, url, title, ts: Date.now(),
            });
          }

          const focusRaw = await redis.hgetall(offtaskKey).catch(() => null);
          const focusData = {};
          if (focusRaw) {
            for (const [sid, stamp] of Object.entries(focusRaw)) focusData[sid] = parseInt(stamp, 10);
          }
          const score = await calcPulseScore(sessionId, focusData);
          io.to(`classpulse:dashboard:${sessionId}`).emit('classpulse:pulse_score', score);
        } catch {}
      }
    } catch (err) {
      console.error('[socket] student:activity forwarding error:', err.message);
    }
  });

  // Lockdown escape attempt: forward to the owning class room so the
  // teacher's live ActiveLesson view shows it as it happens.
  events.on('lockdown:event', ({ studentId, classId, sessionId, eventType, detail }) => {
    if (!classId) return;
    io.to(`class:${classId}`).emit('lockdown:event', { studentId, sessionId, eventType, detail, ts: Date.now() });
  });

  // Screenshot captured: notify all class rooms the student belongs to
  events.on('student:screenshot', async ({ studentId, screenshotId, url, trigger, created_at }) => {
    if (!studentId) return;
    try {
      const cacheKey = `student:classes:${studentId}`;
      const cached   = await redis.get(cacheKey);
      const classIds = cached ? JSON.parse(cached) : [];
      const payload  = { studentId, screenshotId, url, trigger, created_at };
      for (const classId of classIds) {
        io.to(`class:${classId}`).emit('student:screenshot', payload);
      }
    } catch {}
  });

  // Raise hand: same class-room fanout as student:screenshot above. Ephemeral
  // (see routes/extension.js's /raise-hand) — nothing persisted, this is
  // just a live nudge to whichever teacher dashboards have this class open.
  events.on('student:raise_hand', async ({ studentId, ts }) => {
    if (!studentId) return;
    try {
      const cacheKey = `student:classes:${studentId}`;
      const cached   = await redis.get(cacheKey);
      const classIds = cached ? JSON.parse(cached) : [];
      const payload  = { studentId, ts };
      for (const classId of classIds) {
        io.to(`class:${classId}`).emit('student:raise_hand', payload);
      }
    } catch {}
  });

  // High-severity safety event (risk_score >= 85) — broadcast to every
  // logged-in staff member immediately, not just the student's own
  // teachers, since self-harm/violence-tier content warrants everyone
  // seeing it, not just whoever happens to have that class room open.
  events.on('safety:urgent_alert', (payload) => {
    io.to('role:staff').emit('safety:urgent_alert', payload);
  });

  // Upstream internet/DNS outage or recovery — same staff-wide broadcast as
  // the safety alert above, distinct event name/banner since this is an
  // infra concern, not a student-safety one.
  events.on('system:internet_alert', (payload) => {
    io.to('role:staff').emit('system:internet_alert', payload);
  });

  // Filter bypass detection -- a student-safety event (the filter has
  // stopped applying to this device, same audience as urgent_alert above),
  // not an infra one.
  events.on('safety:filter_bypass', (payload) => {
    io.to('role:staff').emit('safety:filter_bypass', payload);
  });

  // HA auto-promotion firing is an infra/ops event, not a student-safety or
  // general-staff one — superadmins only (see sockets join logic above).
  events.on('system:ha_auto_promote', (payload) => {
    io.to('role:superadmin').emit('system:ha_auto_promote', payload);
  });

  // Teacher-initiated screenshot request: push to student's extension socket
  events.on('teacher:screenshot_request', ({ studentId }) => {
    if (studentId) {
      io.to(`student:${studentId}`).emit('screenshot:request');
    }
  });

  // Admin Live View: ask the student's extension for one frame, then relay
  // whatever comes back to anyone currently watching that student. Nothing
  // here touches the database — see /extension/liveview-frame's comment for
  // why this is deliberately ephemeral.
  events.on('admin:liveview_request', ({ studentId }) => {
    if (studentId) {
      io.to(`student:${studentId}`).emit('liveview:request');
    }
  });

  events.on('student:liveview_frame', ({ studentId, dataUrl, url, title, capturedAt }) => {
    if (studentId) {
      io.to(`liveview:${studentId}`).emit('liveview:frame', { studentId, dataUrl, url, title, capturedAt });
    }
  });

  // Remote device commands — same shape as screenshot_request above, one
  // event in, one matching command out to the student's extension socket.
  events.on('teacher:lock_request', ({ studentId, message, targetPath, allowPulse }) => {
    // targetPath/allowPulse: ClassPulse focus-lock — the extension opens the
    // session page and exempts it from the overlay so students can still
    // answer questions while everything else is locked.
    if (studentId) io.to(`student:${studentId}`).emit('lock:engage', { message, targetPath, allowPulse });
  });

  events.on('teacher:unlock_request', ({ studentId }) => {
    if (studentId) io.to(`student:${studentId}`).emit('lock:release');
  });

  events.on('teacher:open_tab_request', ({ studentId, url }) => {
    if (studentId) io.to(`student:${studentId}`).emit('tab:open', { url });
  });

  events.on('teacher:close_tab_request', ({ studentId }) => {
    if (studentId) io.to(`student:${studentId}`).emit('tab:close');
  });

  // Chat — every authenticated socket (student or staff) already joins its
  // own private room on connect (see above), so this same room works for
  // delivering to a teacher's own browser session, not just the extension.
  events.on('chat:new_message', ({ threadId, message, recipientIds }) => {
    for (const id of recipientIds || []) {
      io.to(`student:${id}`).emit('chat:message', { threadId, message });
    }
  });

  // Screen broadcasting (routes/liveView.js's class-broadcast/* routes) —
  // fans a teacher-captured frame out to every roster member's own private
  // room, same direction as the remote-device commands above (teacher ->
  // students), not the class:${classId} dashboard-fanout room those other
  // handlers use (that's teacher-facing only; students never join it).
  events.on('class:broadcast_frame', async ({ classId, teacherName, dataUrl }) => {
    try {
      const { rows } = await query('SELECT student_id FROM class_members WHERE class_id = $1', [classId]);
      for (const { student_id } of rows) {
        io.to(`student:${student_id}`).emit('broadcast:frame', { classId, teacherName, dataUrl });
      }
    } catch {}
  });

  events.on('class:broadcast_end', async ({ classId }) => {
    try {
      const { rows } = await query('SELECT student_id FROM class_members WHERE class_id = $1', [classId]);
      for (const { student_id } of rows) {
        io.to(`student:${student_id}`).emit('broadcast:end', { classId });
      }
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // ClassPulse event bus → WebSocket bridge
  // ---------------------------------------------------------------------------

  // Teacher navigated: push new page to both student session room and dashboard
  events.on('classpulse:page_changed', ({ sessionId, page }) => {
    io.to(`classpulse:session:${sessionId}`).emit('classpulse:page_changed', { page });
    io.to(`classpulse:dashboard:${sessionId}`).emit('classpulse:page_changed', { page });
  });

  // New student response: push to teacher dashboard with student name,
  // then recalculate and broadcast the Pulse Score.
  events.on('classpulse:new_response', async ({ sessionId, questionId, studentId, studentName, responseType, textValue, optionIds, responseCount }) => {
    io.to(`classpulse:dashboard:${sessionId}`).emit('classpulse:response', {
      questionId,
      studentId,
      studentName,
      responseType,
      textValue,
      optionIds,
      responseCount,
      ts: Date.now(),
    });
    try {
      const offtaskKey = `classpulse:session:${sessionId}:offtask`;
      const focusRaw = await redis.hgetall(offtaskKey).catch(() => null);
      const focusData = {};
      if (focusRaw) {
        for (const [sid, stamp] of Object.entries(focusRaw)) focusData[sid] = parseInt(stamp, 10);
      }
      const score = await calcPulseScore(sessionId, focusData);
      io.to(`classpulse:dashboard:${sessionId}`).emit('classpulse:pulse_score', score);
    } catch {}
  });

  // Student joined the session: notify teacher dashboard
  events.on('classpulse:student_joined', ({ sessionId, studentId, studentName }) => {
    io.to(`classpulse:dashboard:${sessionId}`).emit('classpulse:student_joined', {
      studentId, studentName, ts: Date.now(),
    });
  });

  // Session ended: dismiss both student join pages and teacher dashboard
  events.on('classpulse:session_ended', ({ sessionId }) => {
    io.to(`classpulse:session:${sessionId}`).emit('classpulse:session_ended', { sessionId });
    io.to(`classpulse:dashboard:${sessionId}`).emit('classpulse:session_ended', { sessionId });
  });

  // Classroom lock engaged/released: send to student session room so the join
  // page can show a "locked" banner and prevent navigation away.
  events.on('classpulse:lock_changed', ({ sessionId, locked, joinCode }) => {
    if (locked) {
      io.to(`classpulse:session:${sessionId}`).emit('classpulse:lock_engaged', { joinCode });
    } else {
      io.to(`classpulse:session:${sessionId}`).emit('classpulse:lock_released', {});
    }
    io.to(`classpulse:dashboard:${sessionId}`).emit('classpulse:lock_changed', { locked });
  });
};

module.exports = setupSockets;
