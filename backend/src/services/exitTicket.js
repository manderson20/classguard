// Staff Technology Exit Ticket — two-page PDFKit document.
//
// Page 1 (IT copy):  device verification checklist, InfoSec/leaving checkboxes, IT signature.
// Page 2 (Staff copy): pre-populated Infosec IQ grade + PhishSim stats, IT signature.

const PDFDocument = require('pdfkit');

const BRAND_COLOR  = '#1e40af'; // blue-800
const LIGHT_GRAY   = '#f1f5f9'; // slate-100
const MID_GRAY     = '#64748b'; // slate-500
const DARK         = '#0f172a'; // slate-900
const LINE_COLOR   = '#cbd5e1'; // slate-300

function line(doc, y, x1 = 54, x2 = 558) {
  doc.moveTo(x1, y).lineTo(x2, y).strokeColor(LINE_COLOR).lineWidth(0.5).stroke();
}

function sectionHeader(doc, text, y) {
  doc.rect(54, y, 504, 18).fill(LIGHT_GRAY);
  doc.fillColor(BRAND_COLOR).fontSize(9).font('Helvetica-Bold')
     .text(text, 58, y + 4, { width: 500 });
  doc.fillColor(DARK);
  return y + 22;
}

function labelLine(doc, label, value, x, y, labelW = 160) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MID_GRAY)
     .text(label, x, y, { width: labelW });
  doc.font('Helvetica').fillColor(DARK)
     .text(value || '', x + labelW, y, { width: 300 });
}

function checkRow(doc, label, y, checked = null) {
  // Draw checkbox squares
  const boxes = [
    { label: 'Yes', x: 370 },
    { label: 'No',  x: 420 },
  ];
  doc.fontSize(9).font('Helvetica').fillColor(DARK)
     .text(label, 58, y, { width: 300 });
  for (const b of boxes) {
    doc.rect(b.x, y - 1, 10, 10).strokeColor(DARK).lineWidth(0.75).stroke();
    if (checked === true  && b.label === 'Yes') doc.text('✓', b.x + 1, y - 1);
    if (checked === false && b.label === 'No')  doc.text('✓', b.x + 1, y - 1);
    doc.fontSize(9).fillColor(DARK).text(b.label, b.x + 13, y, { width: 40 });
  }
}

function sigBlock(doc, y) {
  doc.fontSize(8).font('Helvetica').fillColor(MID_GRAY);
  doc.text('Signature:', 58, y);
  line(doc, y + 10, 110, 340);
  doc.text('Date:', 360, y);
  line(doc, y + 10, 385, 558);
}

function statRow(doc, label, value, x, y, highlight = false) {
  if (highlight) {
    doc.rect(x, y - 2, 350, 14).fill('#fef3c7');
    doc.fillColor(DARK);
  }
  doc.fontSize(9).font('Helvetica').fillColor(MID_GRAY)
     .text(label + ':', x + 4, y, { width: 220, continued: false });
  doc.font('Helvetica-Bold').fillColor(highlight ? '#92400e' : DARK)
     .text(String(value ?? '—'), x + 230, y, { width: 100 });
}

// ---------------------------------------------------------------------------
// Generate a single exit ticket (2 pages) for one staff member.
// `learner`  — row from infoseciq_learners (may be null if not in Infosec IQ)
// `devices`  — array of Snipe-IT devices assigned to this person
// `tickets`  — array of open Zammad tickets for this person
// `required` — required course count (e.g. 10)
// ---------------------------------------------------------------------------
function generateTicket(doc, staffName, email, learner, devices, tickets, required = 10, isFirst = false) {
  if (!isFirst) doc.addPage();

  const today    = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const schoolYear = (() => {
    const now = new Date();
    const y   = now.getFullYear();
    return now.getMonth() >= 7 ? `${y}–${y + 1}` : `${y - 1}–${y}`;
  })();

  // -------------------------------------------------------------------------
  // PAGE 1 — IT copy
  // -------------------------------------------------------------------------
  let y = 54;

  // Header
  doc.rect(54, y, 504, 36).fill(BRAND_COLOR);
  doc.fillColor('white').fontSize(14).font('Helvetica-Bold')
     .text('Staff Technology Exit Ticket', 58, y + 6, { width: 500 });
  doc.fontSize(9).font('Helvetica')
     .text(`School Year ${schoolYear}  ·  IT Copy`, 58, y + 22, { width: 500 });
  doc.fillColor(DARK);
  y += 46;

  // Staff info
  y = sectionHeader(doc, 'STAFF INFORMATION', y);
  labelLine(doc, 'Name:', staffName, 58, y);
  labelLine(doc, 'Email:', email, 300, y);
  y += 16;
  labelLine(doc, 'Department:', learner?.department || '', 58, y);
  labelLine(doc, 'Date:', today, 300, y);
  y += 22;

  // Device checkout
  y = sectionHeader(doc, 'DEVICE CHECKOUT VERIFICATION', y);
  doc.fontSize(8).font('Helvetica').fillColor(MID_GRAY)
     .text('Verify what is checked out matches what is in possession:', 58, y, { width: 504 });
  y += 14;

  if (devices.length > 0) {
    doc.fontSize(8).font('Helvetica-Bold').fillColor(DARK).text('Assigned devices from Snipe-IT:', 58, y);
    y += 13;
    for (const d of devices.slice(0, 8)) {
      doc.fontSize(8).font('Helvetica').fillColor(DARK)
         .text(`• ${d.device_name || 'Unknown'}${d.asset_tag ? '  #' + d.asset_tag : ''}${d.device_model ? '  (' + d.device_model + ')' : ''}`, 66, y, { width: 490 });
      y += 12;
    }
    if (devices.length > 8) {
      doc.fontSize(7.5).fillColor(MID_GRAY).text(`… and ${devices.length - 8} more`, 66, y);
      y += 12;
    }
  } else {
    doc.fontSize(8).font('Helvetica').fillColor(MID_GRAY)
       .text('No devices found in Snipe-IT for this staff member.', 58, y);
    y += 12;
  }

  y += 4;
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MID_GRAY).text('Notes:', 58, y);
  y += 14;
  line(doc, y); y += 14;
  line(doc, y); y += 14;
  line(doc, y); y += 18;

  doc.fontSize(8).font('Helvetica').fillColor(DARK);
  checkRow(doc, 'Device verification completed?', y);
  y += 20;

  // InfoSec
  y = sectionHeader(doc, 'INFOSEC CYBERSECURITY TRAINING', y);
  const trainDone = learner
    ? (learner.training_completed_count >= required || learner.modules_completed >= required)
    : null;
  checkRow(doc, 'Staff member has completed all required InfoSec cybersecurity trainings for the year?', y, trainDone);
  y += 24;

  // Leaving district
  y = sectionHeader(doc, 'DISTRICT DEPARTURE', y);
  checkRow(doc, 'Is this staff member leaving the district / surrendering technology?', y);
  y += 20;
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MID_GRAY).text('Notes:', 58, y);
  y += 14;
  line(doc, y); y += 14;
  line(doc, y); y += 22;

  // Open Zammad tickets
  y = sectionHeader(doc, 'OPEN HELP DESK TICKETS', y);
  if (tickets.length === 0) {
    doc.fontSize(8).font('Helvetica').fillColor(MID_GRAY)
       .text('No open tickets found for this staff member.', 58, y, { width: 504 });
    y += 14;
  } else {
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(MID_GRAY)
       .text('#', 58, y, { width: 40 })
       .text('Title', 100, y, { width: 200 })
       .text('State', 304, y, { width: 70 })
       .text('Priority', 378, y, { width: 70 })
       .text('Created', 452, y, { width: 100 });
    y += 12;
    line(doc, y); y += 4;
    const stateColor = s => s?.toLowerCase().includes('open') ? '#15803d' : s?.toLowerCase().includes('new') ? '#1d4ed8' : MID_GRAY;
    const priColor   = p => p?.toLowerCase() === 'high' || p?.toLowerCase() === '3 high' ? '#dc2626' : DARK;
    for (const t of tickets.slice(0, 10)) {
      doc.fontSize(7.5).font('Helvetica').fillColor(DARK)
         .text(t.number || '—', 58, y, { width: 40 });
      doc.fillColor(DARK)
         .text((t.title || '—').slice(0, 50), 100, y, { width: 200 });
      doc.fillColor(stateColor(t.state))
         .text(t.state || '—', 304, y, { width: 70 });
      doc.fillColor(priColor(t.priority))
         .text(t.priority || '—', 378, y, { width: 70 });
      doc.fillColor(MID_GRAY)
         .text(t.created_at ? new Date(t.created_at).toLocaleDateString() : '—', 452, y, { width: 100 });
      y += 12;
    }
    if (tickets.length > 10) {
      doc.fontSize(7.5).fillColor(MID_GRAY).text(`… and ${tickets.length - 10} more open tickets`, 58, y);
      y += 12;
    }
    doc.fillColor(DARK);
    y += 4;
    doc.fontSize(8).font('Helvetica').fillColor(DARK)
       .text('Review each open ticket above with the staff member to determine if it can be closed or should remain open:', 58, y, { width: 504 });
    y += 14;
    line(doc, y); y += 14;
    line(doc, y); y += 14;
  }
  y += 4;

  // Agreement + signature
  y = sectionHeader(doc, 'ACKNOWLEDGEMENT', y);
  doc.fontSize(8).font('Helvetica').fillColor(DARK)
     .text('Do you agree with all changes listed above? If yes, please sign:', 58, y, { width: 504 });
  y += 18;
  sigBlock(doc, y);

  // -------------------------------------------------------------------------
  // PAGE 2 — Staff member copy
  // -------------------------------------------------------------------------
  doc.addPage();
  y = 54;

  // Header
  doc.rect(54, y, 504, 36).fill(BRAND_COLOR);
  doc.fillColor('white').fontSize(14).font('Helvetica-Bold')
     .text('Staff Technology Exit Ticket', 58, y + 6, { width: 500 });
  doc.fontSize(9).font('Helvetica')
     .text(`School Year ${schoolYear}  ·  Please turn this page in to your Building Administrator`, 58, y + 22, { width: 500 });
  doc.fillColor(DARK);
  y += 46;

  // Staff name + grade
  doc.rect(54, y, 504, 30).fill(LIGHT_GRAY);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK)
     .text(staffName, 58, y + 6, { width: 340 });
  if (learner?.letter_grade) {
    const gradeColors = { A: '#15803d', B: '#1d4ed8', C: '#854d0e', D: '#c2410c', F: '#b91c1c' };
    const gc = gradeColors[learner.letter_grade] || MID_GRAY;
    doc.rect(440, y + 4, 44, 22).fill(gc);
    doc.fillColor('white').fontSize(13).font('Helvetica-Bold')
       .text(`  ${learner.letter_grade}`, 448, y + 8);
    doc.fillColor(DARK).fontSize(8).font('Helvetica')
       .text('Infosec Grade', 496, y + 10);
  }
  doc.fillColor(DARK);
  y += 38;

  // PhishSim stats
  y = sectionHeader(doc, 'PHISHSIM PHISHING SIMULATION RESULTS', y);

  const phishStats = [
    { label: 'Phish Count (times successfully phished)', value: learner?.phished_count ?? 0, warn: (learner?.phished_count ?? 0) > 2 },
    { label: 'Replies to Phishing Attacks',               value: learner?.replied_count ?? 0, warn: (learner?.replied_count ?? 0) > 0 },
    { label: 'Replies Matching Expressions',              value: learner?.matched_count ?? 0, warn: (learner?.matched_count ?? 0) > 0 },
    { label: 'Data Entry Count',                          value: learner?.data_entry_count ?? 0, warn: (learner?.data_entry_count ?? 0) > 0 },
    { label: 'Opened Attachments',                        value: learner?.attachment_count ?? 0, warn: (learner?.attachment_count ?? 0) > 0 },
    { label: 'Teachable Moments',                         value: learner?.teachable_count ?? 0 },
    { label: 'Suspicious Emails Submitted',               value: learner?.plugin_email_report_count ?? 0 },
    { label: 'Phishing Simulations Identified',           value: learner?.plugin_simulation_report_count ?? 0 },
  ];

  for (const s of phishStats) {
    statRow(doc, s.label, s.value, 58, y, s.warn);
    y += 16;
  }
  y += 4;

  // Training stats
  y = sectionHeader(doc, 'AWARENESS TRAINING RESULTS', y);

  const trainStats = [
    { label: 'Started Trainings',    value: learner?.training_started_count ?? 0 },
    { label: 'Completed Trainings',  value: learner?.training_completed_count ?? 0 },
  ];

  for (const s of trainStats) {
    statRow(doc, s.label, s.value, 58, y);
    y += 16;
  }
  y += 6;

  // Course completion bar
  const completed = learner?.modules_completed ?? 0;
  const pct       = Math.min(1, completed / required);
  const barW      = 350;

  doc.rect(58, y, barW, 16).fill('#e2e8f0');
  doc.rect(58, y, Math.round(barW * pct), 16).fill(pct >= 1 ? '#15803d' : pct >= 0.6 ? '#ca8a04' : '#dc2626');

  const courseLabel = `Courses Completed:  ${completed} / ${required}  (All Must Be Completed)`;
  doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
     .text(courseLabel, 62, y + 4, { width: barW - 4 });
  doc.fillColor(DARK);
  y += 26;

  if (pct < 1) {
    doc.rect(58, y, 504, 14).fill('#fef2f2');
    doc.fillColor('#991b1b').fontSize(8).font('Helvetica-Bold')
       .text(`⚠  ${required - completed} course(s) remaining — all must be completed before end of year.`, 62, y + 3, { width: 496 });
    doc.fillColor(DARK);
    y += 20;
  } else {
    doc.rect(58, y, 504, 14).fill('#f0fdf4');
    doc.fillColor('#15803d').fontSize(8).font('Helvetica-Bold')
       .text('✓  All required courses completed.', 62, y + 3, { width: 496 });
    doc.fillColor(DARK);
    y += 20;
  }

  y += 8;

  // Checkout confirmation
  y = sectionHeader(doc, 'TECHNOLOGY CHECKOUT CONFIRMATION', y);
  doc.fontSize(9).font('Helvetica').fillColor(DARK)
     .text('This staff member has checked out with the Technology Department.', 58, y, { width: 504 });
  y += 20;
  sigBlock(doc, y);
}

// ---------------------------------------------------------------------------
// Build a PDF stream for one or more staff members.
// `staffList` = [{ staffName, email, learner, devices, tickets }]
// ---------------------------------------------------------------------------
function buildExitTicketPdf(staffList, requiredCourses = 10) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    autoFirstPage: true,
  });

  staffList.forEach((s, i) => {
    generateTicket(doc, s.staffName, s.email, s.learner, s.devices, s.tickets || [], requiredCourses, i === 0);
  });

  doc.end();
  return doc;
}

module.exports = { buildExitTicketPdf };
