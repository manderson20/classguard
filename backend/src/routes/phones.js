const express = require('express');
const multer  = require('multer');
const { query, pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const phoneSpreadsheetImport = require('../services/phoneSpreadsheetImport');
const phoneTemplateImport    = require('../services/phoneTemplateImport');
const phoneDirectory = require('../services/phoneDirectory');
const phoneIpam = require('../services/phoneIpam');

const router = express.Router();
router.use(authenticate, requireMinRole('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// Spreadsheet import — preview (rolled back) vs commit, same pattern as the
// PHPiPAM dump importer.
// ---------------------------------------------------------------------------
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await phoneSpreadsheetImport.run(req.file.buffer, req.query.commit === 'true');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Generic template — a clean, reusable import format for any district (as
// opposed to /import above, which only understands this district's
// hand-built one-off "Phone System.xlsx" layout).
// ---------------------------------------------------------------------------
router.get('/template.xlsx', async (req, res) => {
  const buffer = await phoneTemplateImport.buildTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="ClassGuard Phone System Template.xlsx"');
  res.send(buffer);
});

router.post('/import-template', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await phoneTemplateImport.run(req.file.buffer, req.query.commit === 'true');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Directory generation
// ---------------------------------------------------------------------------
router.get('/directory.docx', async (req, res) => {
  try {
    const buffer = await phoneDirectory.generate({
      districtName: req.query.district || undefined,
      schoolYear: req.query.year || undefined,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="Phone Directory.docx"');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/directory-settings', async (req, res) => {
  res.json({ middle_title: await phoneDirectory.getMiddleTitle() });
});

router.put('/directory-settings', async (req, res) => {
  await phoneDirectory.setMiddleTitle(req.body.middle_title || '');
  res.json({ middle_title: await phoneDirectory.getMiddleTitle() });
});

// ---------------------------------------------------------------------------
// Phones — full CRUD
// ---------------------------------------------------------------------------
router.get('/phones', async (req, res) => {
  const { search } = req.query;
  const conditions = [];
  const vals = [];
  if (search) { vals.push(`%${search}%`); conditions.push(`(display_name ILIKE $${vals.length} OR extension ILIKE $${vals.length} OR device_id ILIKE $${vals.length} OR building ILIKE $${vals.length})`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(`SELECT * FROM phones ${where} ORDER BY building, extension`, vals);
  res.json(rows);
});

router.post('/phones', async (req, res) => {
  const f = req.body;
  const { rows: [row] } = await query(
    `INSERT INTO phones (device_id, device_type, mac_address, ip_address, network_switch, switch_interface,
        building, room_number, extension, display_name, voicemail_email, leave_voicemail_on_server,
        egress_outside_number, outbound_egress_cid, ingress_phone_number, emergency_egress_cid,
        paging_groups, ring_groups, sidecar_needed, sidecar_serial, sidecar_model,
        headset_needed, headset_model, wall_mount_needed, wall_mount_model, handset_needed, handset_model, notes,
        include_in_directory, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
     RETURNING *`,
    [f.device_id, f.device_type || null, f.mac_address || null, f.ip_address || null, f.network_switch || null,
     f.switch_interface || null, f.building || null, f.room_number || null, f.extension || null, f.display_name || null,
     f.voicemail_email || null, f.leave_voicemail_on_server || null, f.egress_outside_number || null,
     f.outbound_egress_cid || null, f.ingress_phone_number || null, f.emergency_egress_cid || null,
     JSON.stringify(f.paging_groups || []), JSON.stringify(f.ring_groups || []),
     !!f.sidecar_needed, f.sidecar_serial || null, f.sidecar_model || null,
     !!f.headset_needed, f.headset_model || null, !!f.wall_mount_needed, f.wall_mount_model || null,
     !!f.handset_needed, f.handset_model || null, f.notes || null,
     f.include_in_directory !== false, req.user.userId]
  );
  const synced = await phoneIpam.syncPhone(row).catch(() => row);
  res.status(201).json(synced);
});

router.put('/phones/:id', async (req, res) => {
  const f = req.body;
  const { rows: [row] } = await query(
    `UPDATE phones SET
       device_type=$1, mac_address=$2, ip_address=$3, network_switch=$4, switch_interface=$5,
       building=$6, room_number=$7, extension=$8, display_name=$9, voicemail_email=$10,
       leave_voicemail_on_server=$11, egress_outside_number=$12, outbound_egress_cid=$13,
       ingress_phone_number=$14, emergency_egress_cid=$15, paging_groups=$16, ring_groups=$17,
       sidecar_needed=$18, sidecar_serial=$19, sidecar_model=$20, headset_needed=$21, headset_model=$22,
       wall_mount_needed=$23, wall_mount_model=$24, handset_needed=$25, handset_model=$26, notes=$27,
       is_active=$28, include_in_directory=$29, updated_at=NOW()
     WHERE id=$30 RETURNING *`,
    [f.device_type || null, f.mac_address || null, f.ip_address || null, f.network_switch || null, f.switch_interface || null,
     f.building || null, f.room_number || null, f.extension || null, f.display_name || null, f.voicemail_email || null,
     f.leave_voicemail_on_server || null, f.egress_outside_number || null, f.outbound_egress_cid || null,
     f.ingress_phone_number || null, f.emergency_egress_cid || null, JSON.stringify(f.paging_groups || []), JSON.stringify(f.ring_groups || []),
     !!f.sidecar_needed, f.sidecar_serial || null, f.sidecar_model || null, !!f.headset_needed, f.headset_model || null,
     !!f.wall_mount_needed, f.wall_mount_model || null, !!f.handset_needed, f.handset_model || null, f.notes || null,
     f.is_active !== false, f.include_in_directory !== false, req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Phone not found' });
  const synced = await phoneIpam.syncPhone(row).catch(() => row);
  res.json(synced);
});

router.delete('/phones/:id', async (req, res) => {
  const { rows: [row] } = await query('DELETE FROM phones WHERE id = $1 RETURNING *', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Phone not found' });
  res.json({ deleted: row });
});

// ---------------------------------------------------------------------------
// Generic list/delete helper for the simpler reference tables
// ---------------------------------------------------------------------------
function simpleResource(path, table, orderBy) {
  router.get(`/${path}`, async (req, res) => {
    const { rows } = await query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
    res.json(rows);
  });
  router.delete(`/${path}/:id`, async (req, res) => {
    const { rows: [row] } = await query(`DELETE FROM ${table} WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: row });
  });
}
simpleResource('caller-id-profiles', 'phone_caller_id_profiles', 'caller_id_name');
simpleResource('did-numbers',        'phone_did_numbers',        'phone_number');
simpleResource('ring-groups',        'phone_ring_groups',        'extension');
simpleResource('parking-lots',       'phone_parking_lots',       'location_name');
simpleResource('extension-rules',    'phone_extension_rules',    'sort_order');

// ---------------------------------------------------------------------------
// Paging groups — full CRUD, joined with IPAM's multicast_groups so the page
// extension and its multicast address/VLAN are managed from one place
// instead of only ever being set by the one-time spreadsheet import.
// ---------------------------------------------------------------------------
router.get('/paging-groups', async (req, res) => {
  const { rows } = await query(
    `SELECT pg.*, mg.group_address, mg.port AS multicast_port, mg.name AS multicast_name
     FROM phone_paging_groups pg
     LEFT JOIN multicast_groups mg ON mg.id = pg.multicast_group_id
     ORDER BY pg.page_extension::int`
  );
  res.json(rows);
});

router.post('/paging-groups', async (req, res) => {
  const f = req.body;
  const { rows: [row] } = await query(
    `INSERT INTO phone_paging_groups (page_extension, description, polycom_group_label, multicast_group_id, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [f.page_extension, f.description || null, f.polycom_group_label || null, f.multicast_group_id || null, f.notes || null]
  );
  res.status(201).json(row);
});

router.put('/paging-groups/:id', async (req, res) => {
  const f = req.body;
  const { rows: [row] } = await query(
    `UPDATE phone_paging_groups SET
       page_extension=$1, description=$2, polycom_group_label=$3, multicast_group_id=$4, notes=$5, updated_at=NOW()
     WHERE id=$6 RETURNING *`,
    [f.page_extension, f.description || null, f.polycom_group_label || null, f.multicast_group_id || null, f.notes || null, req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.delete('/paging-groups/:id', async (req, res) => {
  const { rows: [row] } = await query('DELETE FROM phone_paging_groups WHERE id = $1 RETURNING *', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: row });
});

module.exports = router;
