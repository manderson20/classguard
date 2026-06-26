const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const snipeit  = require('../services/snipeit');
const { syncTechLabRoles } = require('../services/techLabSync');

const ROLE_HIERARCHY = { student: 0, student_technician: 0.5, teacher: 1, admin: 2, superadmin: 3 };

// student_technician (0.5) and above
const techAccess = [authenticate, requireMinRole('student_technician')];

async function isInstructor(userId, role) {
  if (['admin', 'superadmin'].includes(role)) return true;
  const { rows } = await pool.query(
    `SELECT is_tech_instructor FROM users WHERE id = $1`, [userId]
  );
  return rows[0]?.is_tech_instructor === true;
}

// ---------------------------------------------------------------------------
// Admin: tech lab class management
// ---------------------------------------------------------------------------

router.get('/admin/classes', authenticate, requireMinRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT tlc.*,
             c.name AS class_name, c.period,
             u.full_name AS instructor_name, u.email AS instructor_email,
             (SELECT COUNT(*) FROM class_members cm WHERE cm.class_id = tlc.class_id) AS student_count
      FROM tech_lab_classes tlc
      LEFT JOIN classes c ON c.id = tlc.class_id
      LEFT JOIN users u ON u.id = tlc.instructor_id
      ORDER BY tlc.created_at
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin/classes', authenticate, requireMinRole('admin'), async (req, res) => {
  const { class_id, oneroster_course_code, display_name, auto_assign } = req.body;
  try {
    let instructorId = null;
    if (class_id) {
      const { rows } = await pool.query(
        `SELECT u.id FROM users u
         JOIN class_members cm ON cm.user_id = u.id
         WHERE cm.class_id = $1 AND u.role IN ('teacher','admin','superadmin')
         LIMIT 1`,
        [class_id]
      );
      instructorId = rows[0]?.id || null;
    }
    const { rows } = await pool.query(
      `INSERT INTO tech_lab_classes
         (class_id, oneroster_course_code, display_name, instructor_id, auto_assign)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [class_id || null, oneroster_course_code || null,
       display_name || null, instructorId, auto_assign ?? true]
    );
    if (instructorId) {
      await pool.query(`UPDATE users SET is_tech_instructor = true WHERE id = $1`, [instructorId]);
    }
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/admin/classes/:id', authenticate, requireMinRole('admin'), async (req, res) => {
  const { class_id, oneroster_course_code, display_name, instructor_id, auto_assign, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE tech_lab_classes SET
         class_id              = COALESCE($1, class_id),
         oneroster_course_code = COALESCE($2, oneroster_course_code),
         display_name          = COALESCE($3, display_name),
         instructor_id         = COALESCE($4, instructor_id),
         auto_assign           = COALESCE($5, auto_assign),
         is_active             = COALESCE($6, is_active),
         updated_at            = NOW()
       WHERE id = $7 RETURNING *`,
      [class_id||null, oneroster_course_code||null, display_name||null,
       instructor_id||null, auto_assign??null, is_active??null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (instructor_id) {
      await pool.query(`UPDATE users SET is_tech_instructor = true WHERE id = $1`, [instructor_id]);
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/admin/classes/:id', authenticate, requireMinRole('admin'), async (req, res) => {
  try {
    const { rows: [tlc] } = await pool.query(
      `SELECT instructor_id FROM tech_lab_classes WHERE id = $1`, [req.params.id]
    );
    await pool.query('DELETE FROM tech_lab_classes WHERE id = $1', [req.params.id]);
    if (tlc?.instructor_id) {
      const { rows: others } = await pool.query(
        `SELECT id FROM tech_lab_classes WHERE instructor_id = $1 LIMIT 1`, [tlc.instructor_id]
      );
      if (!others.length) {
        await pool.query(`UPDATE users SET is_tech_instructor = false WHERE id = $1`, [tlc.instructor_id]);
      }
    }
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/assign-roles — manually trigger role sync for all tech classes
router.post('/admin/assign-roles', authenticate, requireMinRole('admin'), async (req, res) => {
  try {
    const result = await syncTechLabRoles();
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /admin/tickets — all tickets across all classes (audit view)
router.get('/admin/tickets', authenticate, requireMinRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT rt.*,
             u.full_name AS assigned_name, u.email AS assigned_email,
             creator.full_name AS creator_name,
             c.name AS class_name,
             (SELECT COUNT(*) FROM repair_notes rn WHERE rn.ticket_id = rt.id) AS note_count,
             (SELECT COUNT(*) FROM repair_pending_changes rpc
              WHERE rpc.ticket_id = rt.id AND rpc.status = 'pending') AS pending_change_count
      FROM repair_tickets rt
      LEFT JOIN users u ON u.id = rt.assigned_to
      LEFT JOIN users creator ON creator.id = rt.created_by
      LEFT JOIN tech_lab_classes tlc ON tlc.id = rt.tech_class_id
      LEFT JOIN classes c ON c.id = tlc.class_id
      ORDER BY rt.created_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Device search — find devices from fleet by serial/name/asset tag
// ---------------------------------------------------------------------------

router.get('/device-search', ...techAccess, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (serial_number)
        id, source, external_id, serial_number, device_name, device_model,
        os_type, assigned_email, asset_tag
      FROM integration_devices
      WHERE serial_number ILIKE $1
         OR device_name   ILIKE $1
         OR asset_tag     ILIKE $1
      ORDER BY serial_number, source
      LIMIT 20
    `, [`%${q}%`]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

router.get('/tickets', ...techAccess, async (req, res) => {
  const instructor = await isInstructor(req.user.userId, req.user.role);
  try {
    if (instructor) {
      const isSupervisor = ['admin', 'superadmin'].includes(req.user.role);
      const where  = isSupervisor ? '' :
        `WHERE rt.tech_class_id IN (SELECT id FROM tech_lab_classes WHERE instructor_id = $1 AND is_active = true)`;
      const params = isSupervisor ? [] : [req.user.userId];
      const { rows } = await pool.query(`
        SELECT rt.*,
               u.full_name AS assigned_name, u.email AS assigned_email,
               creator.full_name AS creator_name, c.name AS class_name,
               (SELECT COUNT(*) FROM repair_notes rn WHERE rn.ticket_id = rt.id) AS note_count,
               (SELECT COUNT(*) FROM repair_pending_changes rpc
                WHERE rpc.ticket_id = rt.id AND rpc.status = 'pending') AS pending_change_count
        FROM repair_tickets rt
        LEFT JOIN users u ON u.id = rt.assigned_to
        LEFT JOIN users creator ON creator.id = rt.created_by
        LEFT JOIN tech_lab_classes tlc ON tlc.id = rt.tech_class_id
        LEFT JOIN classes c ON c.id = tlc.class_id
        ${where}
        ORDER BY rt.created_at DESC LIMIT 100
      `, params);
      return res.json(rows);
    }
    // Student: own tickets only
    const { rows } = await pool.query(`
      SELECT rt.*,
             (SELECT COUNT(*) FROM repair_notes rn WHERE rn.ticket_id = rt.id) AS note_count,
             (SELECT COUNT(*) FROM repair_pending_changes rpc
              WHERE rpc.ticket_id = rt.id AND rpc.status = 'pending') AS pending_change_count
      FROM repair_tickets rt
      WHERE rt.assigned_to = $1
      ORDER BY rt.created_at DESC
    `, [req.user.userId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tickets', ...techAccess, async (req, res) => {
  const { title, device_serial, device_name, device_model,
          snipeit_asset_id, snipeit_asset_tag, priority, initial_condition } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const { rows: [classRow] } = await pool.query(`
      SELECT tlc.id FROM tech_lab_classes tlc
      JOIN class_members cm ON cm.class_id = tlc.class_id
      WHERE cm.user_id = $1 AND tlc.is_active = true
      LIMIT 1
    `, [req.user.userId]);

    const { rows } = await pool.query(
      `INSERT INTO repair_tickets
         (title, device_serial, device_name, device_model, snipeit_asset_id, snipeit_asset_tag,
          tech_class_id, assigned_to, created_by, priority, initial_condition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10) RETURNING *`,
      [title, device_serial||null, device_name||null, device_model||null,
       snipeit_asset_id||null, snipeit_asset_tag||null,
       classRow?.id||null, req.user.userId,
       priority||'normal', initial_condition||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tickets/:id', ...techAccess, async (req, res) => {
  try {
    const { rows: [ticket] } = await pool.query(`
      SELECT rt.*,
             u.full_name AS assigned_name, u.email AS assigned_email,
             creator.full_name AS creator_name, c.name AS class_name
      FROM repair_tickets rt
      LEFT JOIN users u ON u.id = rt.assigned_to
      LEFT JOIN users creator ON creator.id = rt.created_by
      LEFT JOIN tech_lab_classes tlc ON tlc.id = rt.tech_class_id
      LEFT JOIN classes c ON c.id = tlc.class_id
      WHERE rt.id = $1
    `, [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const instructor = await isInstructor(req.user.userId, req.user.role);
    if (!instructor && ticket.assigned_to !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const notesQ = instructor
      ? `SELECT rn.*, u.full_name AS author_name FROM repair_notes rn LEFT JOIN users u ON u.id = rn.author_id WHERE rn.ticket_id = $1 ORDER BY rn.created_at`
      : `SELECT rn.*, u.full_name AS author_name FROM repair_notes rn LEFT JOIN users u ON u.id = rn.author_id WHERE rn.ticket_id = $1 AND rn.is_private = false ORDER BY rn.created_at`;
    const { rows: notes } = await pool.query(notesQ, [req.params.id]);

    const { rows: changes } = await pool.query(`
      SELECT rpc.*, reviewer.full_name AS reviewer_name
      FROM repair_pending_changes rpc
      LEFT JOIN users reviewer ON reviewer.id = rpc.reviewed_by
      WHERE rpc.ticket_id = $1
      ORDER BY rpc.submitted_at DESC
    `, [req.params.id]);

    res.json({ ...ticket, notes, pending_changes: changes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/tickets/:id', ...techAccess, async (req, res) => {
  const { status, priority, resolution } = req.body;
  try {
    const { rows: [ticket] } = await pool.query(`SELECT * FROM repair_tickets WHERE id = $1`, [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const instructor = await isInstructor(req.user.userId, req.user.role);
    if (!instructor && ticket.assigned_to !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows } = await pool.query(
      `UPDATE repair_tickets SET
         status     = COALESCE($1, status),
         priority   = COALESCE($2, priority),
         resolution = COALESCE($3, resolution),
         updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [status||null, priority||null, resolution||null, req.params.id]
    );
    if (status) {
      await pool.query(
        `INSERT INTO repair_notes (ticket_id, author_id, note_type, content)
         VALUES ($1,$2,'status_change',$3)`,
        [req.params.id, req.user.userId, `Status changed to: ${status}`]
      );
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tickets/:id/notes', ...techAccess, async (req, res) => {
  const { content, note_type, is_private } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  try {
    const { rows: [ticket] } = await pool.query(`SELECT * FROM repair_tickets WHERE id = $1`, [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const instructor = await isInstructor(req.user.userId, req.user.role);
    if (!instructor && ticket.assigned_to !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows } = await pool.query(
      `INSERT INTO repair_notes (ticket_id, author_id, note_type, content, is_private)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, req.user.userId, note_type||'note', content, instructor && is_private === true]
    );
    await pool.query(`UPDATE repair_tickets SET updated_at = NOW() WHERE id = $1`, [req.params.id]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tickets/:id/pending-changes', ...techAccess, async (req, res) => {
  const { change_type, target_serial, target_snipeit_id, target_asset_tag, change_data, student_notes } = req.body;
  if (!change_type || !change_data) {
    return res.status(400).json({ error: 'change_type and change_data required' });
  }
  try {
    const { rows: [ticket] } = await pool.query(`SELECT * FROM repair_tickets WHERE id = $1`, [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const instructor = await isInstructor(req.user.userId, req.user.role);
    if (!instructor && ticket.assigned_to !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows } = await pool.query(
      `INSERT INTO repair_pending_changes
         (ticket_id, change_type, target_serial, target_snipeit_id, target_asset_tag,
          change_data, student_notes, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, change_type, target_serial||null, target_snipeit_id||null, target_asset_tag||null,
       JSON.stringify(change_data), student_notes||null, req.user.userId]
    );
    if (['open', 'in_progress'].includes(ticket.status)) {
      await pool.query(
        `UPDATE repair_tickets SET status = 'pending_approval', updated_at = NOW() WHERE id = $1`,
        [req.params.id]
      );
    }
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tickets/:id/pending-changes/:changeId', ...techAccess, async (req, res) => {
  try {
    const { rows: [change] } = await pool.query(
      `SELECT * FROM repair_pending_changes WHERE id = $1 AND ticket_id = $2`,
      [req.params.changeId, req.params.id]
    );
    if (!change) return res.status(404).json({ error: 'Not found' });
    if (change.status !== 'pending') return res.status(400).json({ error: 'Can only withdraw pending changes' });

    const instructor = await isInstructor(req.user.userId, req.user.role);
    if (!instructor && change.submitted_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    await pool.query(`DELETE FROM repair_pending_changes WHERE id = $1`, [req.params.changeId]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Instructor: approval queue
// ---------------------------------------------------------------------------

router.get('/instructor/approvals', ...techAccess, async (req, res) => {
  if (!await isInstructor(req.user.userId, req.user.role)) {
    return res.status(403).json({ error: 'Instructor access required' });
  }
  try {
    const isSupervisor = ['admin', 'superadmin'].includes(req.user.role);
    const where  = isSupervisor ? '' :
      `AND rt.tech_class_id IN (SELECT id FROM tech_lab_classes WHERE instructor_id = $1 AND is_active = true)`;
    const params = isSupervisor ? [] : [req.user.userId];
    const { rows } = await pool.query(`
      SELECT rpc.*,
             rt.title AS ticket_title, rt.device_serial, rt.device_name,
             submitter.full_name AS submitter_name, submitter.email AS submitter_email
      FROM repair_pending_changes rpc
      JOIN repair_tickets rt ON rt.id = rpc.ticket_id
      JOIN users submitter ON submitter.id = rpc.submitted_by
      WHERE rpc.status = 'pending' ${where}
      ORDER BY rpc.submitted_at
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/instructor/approvals/:changeId', ...techAccess, async (req, res) => {
  if (!await isInstructor(req.user.userId, req.user.role)) {
    return res.status(403).json({ error: 'Instructor access required' });
  }
  const { action, review_note } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }
  try {
    const { rows: [change] } = await pool.query(`
      SELECT rpc.*, rt.tech_class_id FROM repair_pending_changes rpc
      JOIN repair_tickets rt ON rt.id = rpc.ticket_id
      WHERE rpc.id = $1 AND rpc.status = 'pending'
    `, [req.params.changeId]);
    if (!change) return res.status(404).json({ error: 'Not found or already reviewed' });

    if (!['admin', 'superadmin'].includes(req.user.role)) {
      const { rows: [cls] } = await pool.query(
        `SELECT id FROM tech_lab_classes WHERE id = $1 AND instructor_id = $2`,
        [change.tech_class_id, req.user.userId]
      );
      if (!cls) return res.status(403).json({ error: 'Access denied — not your class' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(
      `UPDATE repair_pending_changes
       SET status = $1, reviewed_by = $2, review_note = $3, reviewed_at = NOW()
       WHERE id = $4`,
      [newStatus, req.user.userId, review_note||null, req.params.changeId]
    );

    await pool.query(
      `INSERT INTO repair_notes (ticket_id, author_id, note_type, content)
       VALUES ($1,$2,'approval_note',$3)`,
      [change.ticket_id, req.user.userId,
       `${newStatus === 'approved' ? 'Approved' : 'Rejected'}: ${change.change_type}${review_note ? ` — ${review_note}` : ''}`]
    );

    if (action === 'approve' && change.target_snipeit_id) {
      applySnipeitChange(change).catch(err =>
        console.error('[tech-lab] snipe-it apply:', err.message)
      );
    }

    // If no more pending changes on ticket, update ticket status
    const { rows: remaining } = await pool.query(
      `SELECT id FROM repair_pending_changes WHERE ticket_id = $1 AND status = 'pending'`,
      [change.ticket_id]
    );
    if (!remaining.length) {
      const nextStatus = newStatus === 'approved' ? 'approved' : 'in_progress';
      await pool.query(
        `UPDATE repair_tickets SET status = $1, updated_at = NOW() WHERE id = $2`,
        [nextStatus, change.ticket_id]
      );
    }

    res.json({ action, changeId: Number(req.params.changeId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/instructor/students', ...techAccess, async (req, res) => {
  if (!await isInstructor(req.user.userId, req.user.role)) {
    return res.status(403).json({ error: 'Instructor access required' });
  }
  try {
    const isSupervisor = ['admin', 'superadmin'].includes(req.user.role);
    const where  = isSupervisor ? '' : `AND tlc.instructor_id = $1`;
    const params = isSupervisor ? [] : [req.user.userId];
    const { rows } = await pool.query(`
      SELECT DISTINCT u.id, u.full_name, u.email, u.role, u.photo_url,
             (SELECT COUNT(*) FROM repair_tickets rt WHERE rt.assigned_to = u.id) AS total_tickets,
             (SELECT COUNT(*) FROM repair_tickets rt WHERE rt.assigned_to = u.id AND rt.status IN ('open','in_progress','pending_approval')) AS open_tickets,
             (SELECT COUNT(*) FROM repair_tickets rt WHERE rt.assigned_to = u.id AND rt.status = 'closed') AS closed_tickets,
             (SELECT COUNT(*) FROM repair_pending_changes rpc
              JOIN repair_tickets rt ON rt.id = rpc.ticket_id
              WHERE rt.assigned_to = u.id AND rpc.status = 'pending') AS pending_approvals
      FROM users u
      JOIN class_members cm ON cm.user_id = u.id
      JOIN tech_lab_classes tlc ON tlc.class_id = cm.class_id
      WHERE u.role = 'student_technician' AND tlc.is_active = true ${where}
      ORDER BY u.full_name
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Internal: apply approved change to Snipe-IT
// ---------------------------------------------------------------------------

async function applySnipeitChange(change) {
  const http = await snipeit.getClient();
  const { change_type, target_snipeit_id, change_data } = change;

  if (change_type === 'archive_device' || change_type === 'update_status') {
    const patch = {};
    if (change_data.status_id) patch.status_id = change_data.status_id;
    if (change_data.notes)     patch.notes     = change_data.notes;
    await http.patch(`/api/v1/hardware/${target_snipeit_id}`, patch);
  } else if (change_type === 'update_notes') {
    await http.patch(`/api/v1/hardware/${target_snipeit_id}`, { notes: change_data.notes });
  } else if (change_type === 'parts_transfer') {
    const note = `Parts transfer: ${change_data.description || ''} (source: ${change_data.source_serial || '?'})`;
    if (change_data.source_snipeit_id) {
      await http.patch(`/api/v1/hardware/${change_data.source_snipeit_id}`, { notes: note }).catch(() => {});
    }
    await http.patch(`/api/v1/hardware/${target_snipeit_id}`, { notes: note });
  }
}

module.exports = router;
