// Generic reports framework -- see services/reports.js for the report
// type registry. Admin-only (not teacher-relevant: IPAM/DNS-fleet-wide/
// device-inventory data isn't roster-scoped the way student data is).
const { Router } = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermissionIfAdmin } = require('../middleware/permissions');
const { REPORT_TYPES, runReport } = require('../services/reports');

const router = Router();
const auth = [authenticate, requireMinRole('admin'), requirePermissionIfAdmin('reports')];

router.get('/types', ...auth, (req, res) => {
  res.json(Object.entries(REPORT_TYPES).map(([key, def]) => ({
    key, label: def.label, description: def.description, params: def.params,
  })));
});

router.get('/history', ...auth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const { rows } = await pool.query(
    `SELECT gr.id, gr.report_type, gr.params, gr.format, gr.summary, gr.generated_at, u.full_name AS generated_by_name
     FROM generated_reports gr
     LEFT JOIN users u ON u.id = gr.generated_by
     ORDER BY gr.generated_at DESC LIMIT $1`,
    [limit]
  );
  res.json(rows);
});

router.post('/generate', ...auth, async (req, res) => {
  const { type, from, to, session_id } = req.body;
  if (!REPORT_TYPES[type]) return res.status(400).json({ error: 'Unknown report type' });

  const params = {};
  if (REPORT_TYPES[type].params.includes('from'))       params.from       = from ? new Date(from) : new Date(Date.now() - 30 * 86400_000);
  if (REPORT_TYPES[type].params.includes('to'))         params.to         = to   ? new Date(to)   : new Date();
  if (REPORT_TYPES[type].params.includes('session_id')) {
    if (!session_id) return res.status(400).json({ error: 'session_id is required for this report type' });
    params.session_id = session_id;
  }

  try {
    const { summary, pdfBuffer } = await runReport(type, params);
    const { rows: [saved] } = await pool.query(
      `INSERT INTO generated_reports (report_type, params, format, summary, file_data, generated_by)
       VALUES ($1,$2,'pdf',$3,$4,$5) RETURNING id`,
      [type, JSON.stringify(params), JSON.stringify(summary), pdfBuffer, req.user.userId]
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${type}-${saved.id}.pdf"`,
      'X-Report-Id': saved.id,
    });
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/download', ...auth, async (req, res) => {
  const { rows: [report] } = await pool.query(`SELECT report_type, file_data FROM generated_reports WHERE id = $1`, [req.params.id]);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${report.report_type}-${req.params.id}.pdf"`,
  });
  res.send(report.file_data);
});

module.exports = router;
