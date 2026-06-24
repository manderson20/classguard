// On-demand parent report (screen time + flagged safety events, see
// services/parentReport.js for exactly what's included/excluded). Staff
// generates it; there's no parent-facing portal or login by design --
// that data is meant to flow through the district's SIS instead.
const { Router } = require('express');
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermissionIfAdmin } = require('../middleware/permissions');
const { teacherOwnsStudent } = require('../services/teacherRoster');
const { generateParentReport } = require('../services/parentReport');

const router = Router();

router.get('/:studentId', authenticate, requireMinRole('teacher'), requirePermissionIfAdmin('screenshots'), async (req, res) => {
  const { studentId } = req.params;

  if (req.user.role === 'teacher' && !(await teacherOwnsStudent(req.user.userId, studentId))) {
    return res.status(403).json({ error: 'This student is not on one of your rosters' });
  }

  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400_000);
  const to   = req.query.to   ? new Date(req.query.to)   : new Date();

  try {
    const pdfBuffer = await generateParentReport(studentId, { from, to });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="parent-report-${studentId}.pdf"`,
    });
    res.send(pdfBuffer);
  } catch (err) {
    if (err.message === 'Student not found') return res.status(404).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
