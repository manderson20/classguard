const { query } = require('../db');

// Admins/superadmins aren't scoped to a roster, only teachers are — every
// privileged per-student action (remote device commands, chat) should only
// ever let a teacher target a student actually on one of their own rosters.
async function teacherOwnsStudent(teacherId, studentId) {
  const { rows } = await query(
    `SELECT 1 FROM class_members cm
     JOIN classes c ON c.id = cm.class_id
     WHERE cm.student_id = $1 AND c.teacher_id = $2 LIMIT 1`,
    [studentId, teacherId]
  );
  return rows.length > 0;
}

module.exports = { teacherOwnsStudent };
