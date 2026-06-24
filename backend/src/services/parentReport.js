// On-demand parent report: screen time + flagged safety events for one
// student over a date range, as a PDF a staff member can hand or email to
// a parent. Deliberately excludes raw browsing/DNS history and the actual
// screenshot images -- those stay staff-only; a parent report describes
// that an incident happened (category, when, how serious) without handing
// out the raw evidence itself.
const PDFDocument = require('pdfkit');
const { query } = require('../db');

const RISK_TIER = (score) => {
  if (score == null) return 'Flagged';
  if (score >= 85) return 'Urgent';
  if (score >= 60) return 'High';
  if (score >= 35) return 'Moderate';
  return 'Low';
};

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

async function getSchoolName() {
  const { rows } = await query(`SELECT value FROM settings WHERE key = 'blockpage_school_name'`);
  return rows[0]?.value || 'ClassGuard';
}

async function getStudent(studentId) {
  const { rows } = await query(
    `SELECT full_name, email, grade_level FROM users WHERE id = $1 AND role = 'student'`,
    [studentId]
  );
  return rows[0];
}

async function getScreenTimeByDay(studentId, from, to) {
  const { rows } = await query(
    `SELECT date_trunc('day', started_at) AS day,
            SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at)))::int AS active_seconds
     FROM screen_time_intervals
     WHERE student_id = $1 AND started_at >= $2 AND started_at < $3
     GROUP BY day ORDER BY day`,
    [studentId, from, to]
  );
  return rows;
}

async function getSafetyEvents(studentId, from, to) {
  const { rows } = await query(
    `SELECT created_at, risk_category, risk_score, status
     FROM screenshots
     WHERE student_id = $1 AND ai_flagged = true
       AND created_at >= $2 AND created_at < $3
     ORDER BY created_at DESC`,
    [studentId, from, to]
  );
  return rows;
}

async function generateParentReport(studentId, { from, to }) {
  const [schoolName, student, screenTimeDays, safetyEvents] = await Promise.all([
    getSchoolName(),
    getStudent(studentId),
    getScreenTimeByDay(studentId, from, to),
    getSafetyEvents(studentId, from, to),
  ]);

  if (!student) throw new Error('Student not found');

  const totalSeconds = screenTimeDays.reduce((sum, d) => sum + d.active_seconds, 0);
  const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.fontSize(18).font('Helvetica-Bold').text(schoolName);
  doc.fontSize(14).font('Helvetica').text('Student Activity Report', { paragraphGap: 10 });
  doc.moveDown(0.5);

  doc.fontSize(11).font('Helvetica-Bold').text('Student: ', { continued: true }).font('Helvetica').text(student.full_name || student.email);
  if (student.grade_level) doc.font('Helvetica-Bold').text('Grade: ', { continued: true }).font('Helvetica').text(student.grade_level);
  doc.font('Helvetica-Bold').text('Reporting period: ', { continued: true }).font('Helvetica').text(`${fmtDate(from)} – ${fmtDate(to)}`);
  doc.font('Helvetica-Bold').text('Generated: ', { continued: true }).font('Helvetica').text(new Date().toLocaleString('en-US'));
  doc.moveDown(1.5);

  doc.fontSize(13).font('Helvetica-Bold').text('Device Screen Time');
  doc.moveDown(0.3);
  if (!screenTimeDays.length) {
    doc.fontSize(11).font('Helvetica').fillColor('#666').text('No recorded device activity in this period.');
    doc.fillColor('#000');
  } else {
    doc.fontSize(11).font('Helvetica-Bold').text(`Total active time: ${formatDuration(totalSeconds)}`);
    doc.moveDown(0.5);
    for (const d of screenTimeDays) {
      doc.font('Helvetica').fontSize(10).text(`${fmtDate(d.day)}  —  ${formatDuration(d.active_seconds)}`);
    }
  }
  doc.moveDown(1.5);

  doc.fontSize(13).font('Helvetica-Bold').text('Flagged Safety Events');
  doc.moveDown(0.3);
  if (!safetyEvents.length) {
    doc.fontSize(11).font('Helvetica').fillColor('#666').text('No flagged safety events in this period.');
    doc.fillColor('#000');
  } else {
    doc.fontSize(10).font('Helvetica').fillColor('#444')
      .text('Each entry below reflects content automatically flagged for staff review. Specific page content and screenshots are retained by school staff and are not included in this summary.', { width: 500 });
    doc.fillColor('#000').moveDown(0.5);
    for (const e of safetyEvents) {
      const tier = RISK_TIER(e.risk_score);
      doc.font('Helvetica-Bold').fontSize(10).text(`${fmtDate(e.created_at)} — ${tier}`, { continued: true })
        .font('Helvetica').text(`   Category: ${e.risk_category || 'unspecified'}   Status: ${e.status}`);
    }
  }

  doc.moveDown(2);
  doc.fontSize(8).fillColor('#888').text(
    `This report was generated by school staff via ClassGuard and reflects only the data categories listed above. ` +
    `Contact your school office with any questions.`,
    { width: 500 }
  );

  doc.end();
  return done;
}

module.exports = { generateParentReport };
