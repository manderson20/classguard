// Generic reports framework -- a registry of report types, each producing
// a PDF snapshot + a JSON summary (for the history list). Adding a new
// report type means adding one entry here; routes/reports.js and the
// frontend's picker are both driven off this registry, not hardcoded
// per-type routes.
const PDFDocument = require('pdfkit');
const { query } = require('../db');
const { buildSessionReport } = require('./classpulse');

function renderHeader(doc, title, subtitle) {
  doc.fontSize(18).font('Helvetica-Bold').text('ClassGuard');
  doc.fontSize(14).font('Helvetica').text(title);
  if (subtitle) doc.fontSize(10).fillColor('#666').text(subtitle).fillColor('#000');
  doc.fontSize(9).fillColor('#888').text(`Generated ${new Date().toLocaleString('en-US')}`).fillColor('#000');
  doc.moveDown(1);
}

function renderTable(doc, headers, rows, colWidths) {
  const startX = doc.x;
  doc.font('Helvetica-Bold').fontSize(9);
  let x = startX;
  headers.forEach((h, i) => { doc.text(h, x, doc.y, { width: colWidths[i], continued: false }); x += colWidths[i]; });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9);
  for (const row of rows) {
    const y = doc.y;
    x = startX;
    row.forEach((cell, i) => { doc.text(String(cell), x, y, { width: colWidths[i] }); x += colWidths[i]; });
    doc.moveDown(0.1);
    if (doc.y > 720) doc.addPage();
  }
}

function pdfToBuffer(doc) {
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.end();
  return done;
}

function countIPv4(cidr) {
  const [, prefix] = cidr.split('/');
  const bits = 32 - parseInt(prefix, 10);
  if (bits <= 0) return 1;
  return Math.pow(2, bits) - 2; // exclude network + broadcast
}

// ---------------------------------------------------------------------------
// IPAM Subnet Utilization
// ---------------------------------------------------------------------------
async function generateIpamUtilization() {
  const { rows: subnets } = await query(
    `SELECT s.id, s.subnet, s.ip_version, s.name, s.alert_threshold_pct,
            COUNT(ia.id)::int AS documented_ips
     FROM ipam_subnets s
     LEFT JOIN ip_addresses ia ON ia.ipam_subnet_id = s.id
     GROUP BY s.id
     ORDER BY s.subnet`
  );

  const rowsForTable = [];
  let overThreshold = 0;
  for (const s of subnets) {
    if (s.ip_version === 4) {
      const total = countIPv4(s.subnet);
      const pct = total > 0 ? Math.round((s.documented_ips / total) * 1000) / 10 : 0;
      if (pct >= (s.alert_threshold_pct || 90)) overThreshold++;
      rowsForTable.push([s.subnet, s.name || '—', s.documented_ips, total, `${pct}%`]);
    } else {
      // IPv6 address space is too large for a meaningful "% full" figure —
      // documented-count is the only sane thing to report.
      rowsForTable.push([s.subnet, s.name || '—', s.documented_ips, '—', 'n/a (IPv6)']);
    }
  }

  const doc = new PDFDocument({ margin: 50 });
  renderHeader(doc, 'IPAM Subnet Utilization Report');
  doc.fontSize(11).font('Helvetica-Bold').text(`${subnets.length} subnets, ${overThreshold} at/over their alert threshold`);
  doc.moveDown(1);
  renderTable(doc, ['Subnet', 'Name', 'Documented', 'Total', 'Utilization'], rowsForTable, [140, 140, 80, 70, 90]);

  const pdfBuffer = await pdfToBuffer(doc);
  return {
    summary: { total_subnets: subnets.length, over_threshold: overThreshold },
    pdfBuffer,
  };
}

// ---------------------------------------------------------------------------
// DNS Filtering / Compliance
// ---------------------------------------------------------------------------
async function generateDnsFiltering({ from, to }) {
  const [{ rows: totals }, { rows: topDomains }, { rows: topReasons }, { rows: cacheRow }] = await Promise.all([
    query(`SELECT action, COUNT(*)::int AS count FROM dns_logs WHERE queried_at >= $1 AND queried_at < $2 GROUP BY action`, [from, to]),
    query(
      `SELECT domain, COUNT(*)::int AS count FROM dns_logs
       WHERE action = 'blocked' AND queried_at >= $1 AND queried_at < $2
       GROUP BY domain ORDER BY count DESC LIMIT 15`,
      [from, to]
    ),
    query(
      `SELECT COALESCE(block_reason, 'unspecified') AS reason, COUNT(*)::int AS count FROM dns_logs
       WHERE action = 'blocked' AND queried_at >= $1 AND queried_at < $2
       GROUP BY reason ORDER BY count DESC`,
      [from, to]
    ),
    query(
      `SELECT COUNT(*) FILTER (WHERE cache_hit = true)::int AS hits, COUNT(*) FILTER (WHERE cache_hit = false)::int AS misses
       FROM dns_logs WHERE queried_at >= $1 AND queried_at < $2`,
      [from, to]
    ),
  ]);

  const totalQueries = totals.reduce((s, t) => s + t.count, 0);
  const blocked = totals.find(t => t.action === 'blocked')?.count || 0;
  const blockRate = totalQueries > 0 ? Math.round((blocked / totalQueries) * 1000) / 10 : 0;
  const { hits = 0, misses = 0 } = cacheRow[0] || {};
  const cacheHitRate = (hits + misses) > 0 ? Math.round((hits / (hits + misses)) * 1000) / 10 : null;

  const doc = new PDFDocument({ margin: 50 });
  renderHeader(doc, 'DNS Filtering Report', `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`);

  doc.fontSize(11).font('Helvetica-Bold').text(`Total queries: ${totalQueries.toLocaleString()}`);
  doc.font('Helvetica').text(`Blocked: ${blocked.toLocaleString()} (${blockRate}%)`);
  if (cacheHitRate != null) doc.text(`Cache hit rate: ${cacheHitRate}%`);
  doc.moveDown(1);

  doc.fontSize(13).font('Helvetica-Bold').text('Block Reasons');
  doc.moveDown(0.3);
  if (!topReasons.length) {
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('No blocked queries in this period.').fillColor('#000');
  } else {
    renderTable(doc, ['Reason', 'Count'], topReasons.map(r => [r.reason, r.count]), [300, 100]);
  }
  doc.moveDown(1);

  doc.fontSize(13).font('Helvetica-Bold').text('Top Blocked Domains');
  doc.moveDown(0.3);
  if (!topDomains.length) {
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('No blocked domains in this period.').fillColor('#000');
  } else {
    renderTable(doc, ['Domain', 'Count'], topDomains.map(d => [d.domain, d.count]), [350, 100]);
  }

  const pdfBuffer = await pdfToBuffer(doc);
  return {
    summary: { total_queries: totalQueries, blocked, block_rate_pct: blockRate, cache_hit_rate_pct: cacheHitRate },
    pdfBuffer,
  };
}

// ---------------------------------------------------------------------------
// Infosec IQ Cybersecurity Awareness
// ---------------------------------------------------------------------------
async function generateInfosecIqAwareness() {
  const [
    { rows: totals },
    { rows: gradeRows },
    { rows: campaigns },
    { rows: highRisk },
    { rows: syncRow },
  ] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::int                                           AS total_learners,
        ROUND(AVG(training_completion_pct), 1)                 AS avg_completion_pct,
        COUNT(*) FILTER (WHERE training_completion_pct = 100)::int AS fully_trained,
        ROUND(AVG(risk_score), 1)                              AS avg_risk_score,
        ROUND(AVG(phishing_susceptibility), 1)                 AS avg_phishing_susc
      FROM infoseciq_learners
    `),
    query(`
      SELECT
        letter_grade,
        COUNT(*)::int                           AS count,
        ROUND(AVG(training_completion_pct), 1) AS avg_completion_pct,
        ROUND(AVG(risk_score), 1)              AS avg_risk_score
      FROM infoseciq_learners
      WHERE letter_grade IS NOT NULL
      GROUP BY letter_grade
      ORDER BY letter_grade
    `),
    query(`
      SELECT name, campaign_type, status, recipients_total, emails_sent,
             clicks, reports, click_rate, report_rate, start_date, end_date
      FROM infoseciq_campaigns
      ORDER BY COALESCE(start_date, '1970-01-01') DESC
      LIMIT 50
    `),
    query(`
      SELECT first_name, last_name, email, letter_grade, risk_score,
             training_completion_pct, phishing_susceptibility
      FROM infoseciq_learners
      WHERE letter_grade IN ('D', 'D+', 'D-', 'F')
         OR risk_score >= 70
      ORDER BY risk_score DESC NULLS LAST, letter_grade
    `),
    query(`SELECT value FROM settings WHERE key = 'last_infoseciq_sync'`),
  ]);

  const t = totals[0] || {};
  const lastSync = syncRow[0]?.value
    ? new Date(syncRow[0].value).toLocaleString('en-US')
    : 'Never';

  const doc = new PDFDocument({ margin: 50 });
  renderHeader(
    doc,
    'Infosec IQ Cybersecurity Awareness Report',
    `Data as of last sync: ${lastSync}`
  );

  if (!t.total_learners) {
    doc.fontSize(11).font('Helvetica').fillColor('#666').text('No learner data synced yet. Run a sync from the Infosec IQ integration settings.');
    const pdfBuffer = await pdfToBuffer(doc);
    return { summary: { total_learners: 0 }, pdfBuffer };
  }

  // Fleet summary
  doc.fontSize(11).font('Helvetica-Bold').text('Fleet Summary');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  doc.text(`Total learners: ${t.total_learners}`);
  doc.text(`Fully trained (100% completion): ${t.fully_trained} (${Math.round((t.fully_trained / t.total_learners) * 100)}%)`);
  doc.text(`Average training completion: ${t.avg_completion_pct ?? '—'}%`);
  doc.text(`Average risk score: ${t.avg_risk_score ?? '—'}`);
  doc.text(`Average phishing susceptibility: ${t.avg_phishing_susc ?? '—'}%`);
  doc.moveDown(1);

  // Grade distribution
  doc.fontSize(13).font('Helvetica-Bold').text('Grade Distribution');
  doc.moveDown(0.3);
  if (!gradeRows.length) {
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('No grade data available.').fillColor('#000');
  } else {
    renderTable(
      doc,
      ['Grade', 'Count', 'Avg Completion %', 'Avg Risk Score'],
      gradeRows.map(r => [r.letter_grade, r.count, `${r.avg_completion_pct ?? '—'}%`, r.avg_risk_score ?? '—']),
      [80, 70, 140, 120]
    );
  }
  doc.moveDown(1);

  // Campaigns
  doc.fontSize(13).font('Helvetica-Bold').text('Phishing Campaigns');
  doc.moveDown(0.3);
  if (!campaigns.length) {
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('No campaigns found.').fillColor('#000');
  } else {
    renderTable(
      doc,
      ['Campaign Name', 'Type', 'Status', 'Sent', 'Clicks', 'Click %', 'Report %'],
      campaigns.map(c => [
        (c.name || '—').substring(0, 35),
        c.campaign_type || '—',
        c.status || '—',
        c.emails_sent ?? '—',
        c.clicks ?? '—',
        c.click_rate != null ? `${Number(c.click_rate).toFixed(1)}%` : '—',
        c.report_rate != null ? `${Number(c.report_rate).toFixed(1)}%` : '—',
      ]),
      [170, 65, 55, 40, 40, 55, 55]
    );
  }
  doc.moveDown(1);

  // High-risk learners
  doc.fontSize(13).font('Helvetica-Bold').text('High-Risk Learners (Grade D/F or Risk Score ≥ 70)');
  doc.moveDown(0.3);
  if (!highRisk.length) {
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('No high-risk learners found.').fillColor('#000');
  } else {
    renderTable(
      doc,
      ['Name', 'Email', 'Grade', 'Risk Score', 'Completion %'],
      highRisk.map(r => [
        `${r.first_name || ''} ${r.last_name || ''}`.trim() || '—',
        r.email || '—',
        r.letter_grade || '—',
        r.risk_score != null ? Number(r.risk_score).toFixed(1) : '—',
        r.training_completion_pct != null ? `${Number(r.training_completion_pct).toFixed(1)}%` : '—',
      ]),
      [140, 160, 45, 70, 80]
    );
  }

  const pdfBuffer = await pdfToBuffer(doc);
  return {
    summary: {
      total_learners:     t.total_learners,
      fully_trained:      t.fully_trained,
      avg_completion_pct: t.avg_completion_pct,
      avg_risk_score:     t.avg_risk_score,
      high_risk_count:    highRisk.length,
      campaign_count:     campaigns.length,
    },
    pdfBuffer,
  };
}

// ---------------------------------------------------------------------------
// Device Fleet Health
// ---------------------------------------------------------------------------
async function generateDeviceFleetHealth() {
  const [{ rows: bySourceStatus }, { rows: stale }, { rows: flagged }] = await Promise.all([
    query(`SELECT source, status, COUNT(*)::int AS count FROM integration_devices GROUP BY source, status ORDER BY source, count DESC`),
    query(`SELECT source, COUNT(*)::int AS count FROM integration_devices WHERE last_seen < NOW() - INTERVAL '30 days' OR last_seen IS NULL GROUP BY source`),
    // Cross-source flag for statuses that explicitly mean "needs attention" —
    // names differ per integration (Snipe-IT's free-text status_labels vs
    // Google's fixed enum), so this is a substring match, not an exact one.
    query(
      `SELECT source, status, device_name, serial_number, last_seen FROM integration_devices
       WHERE status ~* 'missing|stolen|problem|repair'
       ORDER BY source, status`
    ),
  ]);

  const totalDevices = bySourceStatus.reduce((s, r) => s + r.count, 0);

  const doc = new PDFDocument({ margin: 50 });
  renderHeader(doc, 'Device Fleet Health Report');

  doc.fontSize(11).font('Helvetica-Bold').text(`Total tracked devices: ${totalDevices.toLocaleString()} across ${[...new Set(bySourceStatus.map(r => r.source))].length} sources`);
  doc.moveDown(1);

  doc.fontSize(13).font('Helvetica-Bold').text('By Source & Status');
  doc.moveDown(0.3);
  renderTable(doc, ['Source', 'Status', 'Count'], bySourceStatus.map(r => [r.source, r.status || '—', r.count]), [150, 220, 80]);
  doc.moveDown(1);

  doc.fontSize(13).font('Helvetica-Bold').text('Stale Devices (no check-in in 30+ days)');
  doc.moveDown(0.3);
  if (!stale.length) {
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('None — every tracked device has checked in within the last 30 days.').fillColor('#000');
  } else {
    renderTable(doc, ['Source', 'Stale Count'], stale.map(r => [r.source, r.count]), [200, 100]);
  }
  doc.moveDown(1);

  doc.fontSize(13).font('Helvetica-Bold').text('Flagged for Attention (missing/stolen/repair/problem)');
  doc.moveDown(0.3);
  if (!flagged.length) {
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('None flagged.').fillColor('#000');
  } else {
    renderTable(
      doc,
      ['Source', 'Status', 'Device', 'Serial'],
      flagged.map(r => [r.source, r.status, r.device_name || '—', r.serial_number || '—']),
      [90, 130, 130, 100]
    );
  }

  const pdfBuffer = await pdfToBuffer(doc);
  return {
    summary: {
      total_devices: totalDevices,
      stale_count: stale.reduce((s, r) => s + r.count, 0),
      flagged_count: flagged.length,
    },
    pdfBuffer,
  };
}

// ---------------------------------------------------------------------------
// ClassPulse Session Summary
// ---------------------------------------------------------------------------
async function generateClasspulseSession({ session_id }) {
  const data = await buildSessionReport(session_id);
  if (!data) throw new Error('Session not found');

  const { session, participation, students, questions, total_responses, flagged_count } = data;

  // Fetch option text for all MC/TF questions in this session's lesson
  const { rows: optionRows } = await query(
    `SELECT o.id, o.text, o.is_correct, o.question_id
     FROM classpulse_question_options o
     JOIN classpulse_questions q  ON q.id  = o.question_id
     JOIN classpulse_pages p      ON p.id  = q.page_id
     JOIN classpulse_sessions s   ON s.lesson_id = p.lesson_id
     WHERE s.id = $1
     ORDER BY o.question_id, o.position`,
    [session_id]
  );
  const optionsByQ = {};
  for (const o of optionRows) {
    (optionsByQ[o.question_id] ||= []).push(o);
  }

  const doc = new PDFDocument({ margin: 50 });
  renderHeader(doc, 'ClassPulse Session Report', `${session.lesson_title || 'Untitled lesson'}${session.class_name ? ' — ' + session.class_name : ''}`);

  // Session metadata
  doc.fontSize(10).font('Helvetica-Bold').text('Session Details').font('Helvetica');
  const started = session.started_at ? new Date(session.started_at).toLocaleString('en-US') : '—';
  const ended   = session.ended_at   ? new Date(session.ended_at).toLocaleString('en-US')   : 'In progress';
  doc.fontSize(9).text(`Teacher: ${session.teacher_name || '—'}`);
  doc.text(`Join Code: ${session.join_code || '—'}   Mode: ${session.mode || '—'}`);
  doc.text(`Started: ${started}   Ended: ${ended}   Duration: ${session.duration_minutes} min`);
  doc.moveDown(0.8);

  // Participation summary
  doc.fontSize(10).font('Helvetica-Bold').text('Participation').font('Helvetica');
  doc.fontSize(9).text(
    `${participation.responded} of ${participation.total_joined} students responded (${participation.participation_pct}%). ` +
    `Total responses: ${total_responses}. Flagged: ${flagged_count}.`
  );
  doc.moveDown(0.8);

  // Questions
  doc.fontSize(10).font('Helvetica-Bold').text('Questions & Responses').font('Helvetica');
  doc.moveDown(0.3);

  for (const q of questions) {
    if (doc.y > 700) doc.addPage();
    const typeLabel = { multiple_choice: 'MC', true_false: 'T/F', short_answer: 'SA', exit_ticket: 'Exit Ticket' }[q.question_type] || q.question_type;
    doc.fontSize(9).font('Helvetica-Bold').text(`[${typeLabel}] ${q.prompt}`, { continued: false });
    doc.font('Helvetica').fillColor('#555').text(`Page: ${q.page_title || '—'}  |  ${q.responses.length} response(s)`).fillColor('#000');
    doc.moveDown(0.3);

    const options = optionsByQ[q.question_id] || [];
    if ((q.question_type === 'multiple_choice' || q.question_type === 'true_false') && options.length > 0) {
      const total = q.responses.length;
      for (const opt of options) {
        const count = q.responses.filter(r => (r.option_ids || []).includes(opt.id)).length;
        const pct   = total > 0 ? Math.round((count / total) * 100) : 0;
        const marker = opt.is_correct ? '✓ ' : '   ';
        doc.fontSize(8).text(`  ${marker}${opt.text}: ${count} (${pct}%)`, { indent: 10 });
      }
    } else {
      // Short answer / exit ticket — list up to 15 responses
      const shown = q.responses.slice(0, 15);
      for (const r of shown) {
        const flag = r.is_flagged ? ' [FLAGGED]' : '';
        doc.fontSize(8).text(`  • ${(r.text_value || '').trim()}${flag}`, { indent: 10 });
      }
      if (q.responses.length > 15) {
        doc.fontSize(8).fillColor('#888').text(`  … and ${q.responses.length - 15} more`, { indent: 10 }).fillColor('#000');
      }
    }
    doc.moveDown(0.5);
  }

  // Student roster
  if (students.length > 0) {
    if (doc.y > 620) doc.addPage();
    doc.fontSize(10).font('Helvetica-Bold').text('Student Roster').font('Helvetica').moveDown(0.3);
    renderTable(
      doc,
      ['Name', 'Email', 'Status', 'Joined'],
      students.map(s => [
        s.full_name || '—',
        s.email || '—',
        s.status,
        s.joined_at ? new Date(s.joined_at).toLocaleTimeString('en-US') : '—',
      ]),
      [160, 180, 70, 100]
    );
  }

  const pdfBuffer = await pdfToBuffer(doc);
  return {
    summary: {
      session_id,
      lesson_title:      session.lesson_title,
      class_name:        session.class_name,
      teacher_name:      session.teacher_name,
      duration_minutes:  session.duration_minutes,
      total_joined:      participation.total_joined,
      responded:         participation.responded,
      participation_pct: participation.participation_pct,
      total_responses,
      flagged_count,
    },
    pdfBuffer,
  };
}

const REPORT_TYPES = {
  ipam_utilization: {
    label: 'IPAM Subnet Utilization',
    description: 'Per-subnet documented IP counts vs. total capacity, flagging anything at or over its alert threshold.',
    params: [],
    generate: generateIpamUtilization,
  },
  dns_filtering: {
    label: 'DNS Filtering Report',
    description: 'Query volume, block rate, top block reasons and domains, and cache hit rate for a date range — suitable for CIPA/E-rate documentation.',
    params: ['from', 'to'],
    generate: generateDnsFiltering,
  },
  device_fleet_health: {
    label: 'Device Fleet Health',
    description: 'Device counts by source/status across every integration (Google Admin, Mosyle, Snipe-IT), stale devices, and anything flagged missing/stolen/in repair.',
    params: [],
    generate: generateDeviceFleetHealth,
  },
  infoseciq_awareness: {
    label: 'Infosec IQ Cybersecurity Awareness',
    description: 'Fleet-wide training completion, grade distribution, phishing campaign results, and a list of high-risk learners (grade D/F or risk score ≥ 70).',
    params: [],
    generate: generateInfosecIqAwareness,
  },
  classpulse_session: {
    label: 'ClassPulse Session Summary',
    description: 'Per-session participation rate, per-question response breakdown, flagged responses, and student roster — suitable for instructional documentation.',
    params: ['session_id'],
    generate: generateClasspulseSession,
  },
};

async function runReport(type, params = {}) {
  const def = REPORT_TYPES[type];
  if (!def) throw new Error(`Unknown report type: ${type}`);
  return def.generate(params);
}

module.exports = { REPORT_TYPES, runReport };
