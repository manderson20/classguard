const { pool } = require('../db');

// Assign student_technician role to students enrolled in designated tech lab classes,
// and mark enrolled teachers as tech instructors. Called after each OneRoster sync.
async function syncTechLabRoles() {
  const { rows: techClasses } = await pool.query(
    `SELECT * FROM tech_lab_classes WHERE is_active = true AND auto_assign = true AND class_id IS NOT NULL`
  );
  if (!techClasses.length) return { assigned: 0, instructorsSet: 0 };

  let assigned = 0, instructorsSet = 0;

  for (const tc of techClasses) {
    const { rows: members } = await pool.query(`
      SELECT u.id, u.role
      FROM users u
      JOIN class_members cm ON cm.user_id = u.id
      WHERE cm.class_id = $1
    `, [tc.class_id]);

    const students = members.filter(m => ['student', 'student_technician'].includes(m.role));
    const teachers = members.filter(m => ['teacher', 'admin', 'superadmin'].includes(m.role));

    for (const s of students) {
      if (s.role !== 'student_technician') {
        await pool.query(`UPDATE users SET role = 'student_technician' WHERE id = $1`, [s.id]);
        assigned++;
      }
    }

    for (const t of teachers) {
      await pool.query(`UPDATE users SET is_tech_instructor = true WHERE id = $1`, [t.id]);
      instructorsSet++;
    }
    if (!tc.instructor_id && teachers.length > 0) {
      await pool.query(
        `UPDATE tech_lab_classes SET instructor_id = $1, updated_at = NOW() WHERE id = $2`,
        [teachers[0].id, tc.id]
      );
    }
  }

  return { assigned, instructorsSet };
}

module.exports = { syncTechLabRoles };
