// Generic Phone System import/export template — unlike phoneSpreadsheetImport.js
// (which parses one district's hand-built, idiosyncratic workbook), this is a
// clean format any district can fill in: one sheet per entity, headers that
// match the schema columns directly, a couple of sample rows showing the
// expected format. Same dry-run/commit pattern as every other importer here.

const ExcelJS = require('exceljs');
const { pool } = require('../db');

const SHEETS = {
  Phones: {
    headers: ['Device ID*', 'Device Type', 'MAC Address', 'IP Address', 'Network Switch', 'Switch Interface',
      'Building', 'Room Number', 'Extension*', 'Display Name*', 'Voicemail Email', 'Leave Voicemail On Server (Yes/No)',
      'Outside Line Access Code', 'Outbound Caller ID', 'Inbound DID', 'Emergency Caller ID',
      'Needs Sidecar (Yes/No)', 'Sidecar Model', 'Needs Headset (Yes/No)', 'Headset Model',
      'Needs Wall Mount (Yes/No)', 'Wall Mount Model', 'Include In Directory (Yes/No)', 'Notes'],
    sample: ['P-1', 'Polycom VVX 411', 'AA:BB:CC:00:11:22', '10.10.5.20', 'SW-MAIN-01', 'Gi1/0/5',
      'Main Building', '101', '21001', 'Jane Smith', 'jsmith@district.org', 'Yes',
      '9', 'Main Building <555-555-1000>', '555-555-1000', 'Main Building <555-555-1000>',
      'No', '', 'No', '', 'No', '', 'Yes', ''],
  },
  'Caller ID Profiles': {
    headers: ['Caller ID Name*', 'Building/Department', 'Address', 'Phone Number', 'Fax Number', 'Connection Type', 'E911 Address'],
    sample: ['Main Office', 'District Office', '123 Main St', '555-555-1000', '555-555-1001', 'VoIP', '123 Main St'],
  },
  'DID Numbers': {
    headers: ['Phone Number*', 'Description', 'Type (phone/fax)', 'Connection Type', 'E911 Address', 'Carrier'],
    sample: ['555-555-1000', 'Main Office Line', 'phone', 'VoIP', '123 Main St', 'Example Telecom'],
  },
  'Ring Groups': {
    headers: ['Extension*', 'Description'],
    sample: ['21500', 'Front Office Ring Group'],
  },
  'Paging Groups': {
    headers: ['Page Extension*', 'Description', 'Polycom Group Label'],
    sample: ['8001', 'Whole Building Page', 'ALL'],
  },
  'Parking Lots': {
    headers: ['Location Name*', 'Extension'],
    sample: ['Main Building', '7001'],
  },
  'Extension Rules': {
    headers: ['Parent Code', 'Extension Code*', 'Meaning', 'Sort Order'],
    sample: ['2xxxx', '21xxx', 'Main Building staff extensions', '1'],
  },
};

async function buildTemplate() {
  const wb = new ExcelJS.Workbook();

  const instructions = wb.addWorksheet('Instructions');
  instructions.columns = [{ width: 90 }];
  [
    'ClassGuard Phone System — Import Template',
    '',
    'Fill in one row per item on each sheet below. Columns marked with * are required.',
    'Leave a cell blank if it doesn\'t apply — don\'t delete columns or reorder them.',
    'Sample rows are provided on each sheet for format reference — delete them before importing your real data.',
    '',
    'Sheets: Phones, Caller ID Profiles, DID Numbers, Ring Groups, Paging Groups, Parking Lots, Extension Rules.',
    'Ring group / paging group membership for individual phones is configured in the app after import, not in this file.',
  ].forEach(line => instructions.addRow([line]));
  instructions.getRow(1).font = { bold: true, size: 14 };

  for (const [name, { headers, sample }] of Object.entries(SHEETS)) {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    ws.columns = headers.map(h => ({ width: Math.max(h.length + 2, 16) }));
    const sampleRow = ws.addRow(sample);
    sampleRow.font = { italic: true, color: { argb: 'FF888888' } };
  }

  return wb.xlsx.writeBuffer();
}

let spCounter = 0;
async function trySavepoint(client, fn, onError) {
  const sp = `sptpl_${spCounter++}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await fn();
    await client.query(`RELEASE SAVEPOINT ${sp}`);
  } catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    onError(e);
  }
}

function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('').trim() || null;
    if (v.text !== undefined) return String(v.text).trim() || null;
    if (v.result !== undefined) return cellText({ value: v.result });
  }
  const s = String(v).trim();
  return s || null;
}

function isYes(v) {
  return !!v && /^(y|yes|true|1)$/i.test(String(v).trim());
}

// Reads a sheet into an array of objects keyed by header text (with the
// trailing "*" stripped), skipping the italic sample row by skipping any row
// whose first cell exactly matches the sample data's first cell.
function readSheet(wb, sheetName, expectedHeaders) {
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return [];
  const headerRow = ws.getRow(1);
  const cols = [];
  headerRow.eachCell((cell, colNumber) => {
    const h = cellText(cell);
    if (h) cols[colNumber] = h.replace(/\*$/, '').trim();
  });

  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj = {};
    let hasData = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = cols[colNumber];
      if (!key) return;
      const val = cellText(cell);
      if (val) hasData = true;
      obj[key] = val;
    });
    if (hasData) rows.push(obj);
  }
  return rows;
}

async function run(buffer, commit) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const client = await pool.connect();
  const warnings = [];
  const counts = {};

  try {
    await client.query('BEGIN');

    // Phones
    let n = 0;
    for (const r of readSheet(wb, 'Phones')) {
      if (!r['Device ID'] || !r['Extension'] || !r['Display Name']) {
        warnings.push(`Phones: skipped row missing Device ID/Extension/Display Name (${JSON.stringify(r)})`);
        continue;
      }
      await trySavepoint(client, async () => {
        await client.query(
          `INSERT INTO phones (device_id, device_type, mac_address, ip_address, network_switch, switch_interface,
              building, room_number, extension, display_name, voicemail_email, leave_voicemail_on_server,
              egress_outside_number, outbound_egress_cid, ingress_phone_number, emergency_egress_cid,
              sidecar_needed, sidecar_model, headset_needed, headset_model, wall_mount_needed, wall_mount_model,
              include_in_directory, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
           ON CONFLICT (device_id) DO UPDATE SET
             device_type=EXCLUDED.device_type, mac_address=EXCLUDED.mac_address, ip_address=EXCLUDED.ip_address,
             network_switch=EXCLUDED.network_switch, switch_interface=EXCLUDED.switch_interface,
             building=EXCLUDED.building, room_number=EXCLUDED.room_number, extension=EXCLUDED.extension,
             display_name=EXCLUDED.display_name, updated_at=NOW()`,
          [r['Device ID'], r['Device Type'] || null, r['MAC Address'] || null, r['IP Address'] || null,
           r['Network Switch'] || null, r['Switch Interface'] || null, r['Building'] || null, r['Room Number'] || null,
           r['Extension'], r['Display Name'], r['Voicemail Email'] || null, r['Leave Voicemail On Server (Yes/No)'] || null,
           r['Outside Line Access Code'] || null, r['Outbound Caller ID'] || null, r['Inbound DID'] || null,
           r['Emergency Caller ID'] || null, isYes(r['Needs Sidecar (Yes/No)']), r['Sidecar Model'] || null,
           isYes(r['Needs Headset (Yes/No)']), r['Headset Model'] || null, isYes(r['Needs Wall Mount (Yes/No)']),
           r['Wall Mount Model'] || null,
           r['Include In Directory (Yes/No)'] ? isYes(r['Include In Directory (Yes/No)']) : true,
           r['Notes'] || null]
        );
        n++;
      }, e => warnings.push(`Phones "${r['Device ID']}": ${e.message}`));
    }
    counts.phones = n;

    n = 0;
    for (const r of readSheet(wb, 'Caller ID Profiles')) {
      if (!r['Caller ID Name']) continue;
      await trySavepoint(client, async () => {
        await client.query(
          `INSERT INTO phone_caller_id_profiles (caller_id_name, building_department, address, phone_number, fax_number, connection_type, e911_address)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (caller_id_name) DO UPDATE SET building_department=EXCLUDED.building_department,
             address=EXCLUDED.address, phone_number=EXCLUDED.phone_number, fax_number=EXCLUDED.fax_number,
             connection_type=EXCLUDED.connection_type, e911_address=EXCLUDED.e911_address, updated_at=NOW()`,
          [r['Caller ID Name'], r['Building/Department'] || null, r['Address'] || null, r['Phone Number'] || null,
           r['Fax Number'] || null, r['Connection Type'] || null, r['E911 Address'] || null]
        );
        n++;
      }, e => warnings.push(`Caller ID Profiles "${r['Caller ID Name']}": ${e.message}`));
    }
    counts.caller_id_profiles = n;

    n = 0;
    for (const r of readSheet(wb, 'DID Numbers')) {
      if (!r['Phone Number']) continue;
      await trySavepoint(client, async () => {
        await client.query(
          `INSERT INTO phone_did_numbers (phone_number, description, number_type, connection_type, e911_address, carrier)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (phone_number) DO UPDATE SET description=EXCLUDED.description, number_type=EXCLUDED.number_type,
             connection_type=EXCLUDED.connection_type, e911_address=EXCLUDED.e911_address, carrier=EXCLUDED.carrier, updated_at=NOW()`,
          [r['Phone Number'], r['Description'] || null, (r['Type (phone/fax)'] || 'phone').toLowerCase(),
           r['Connection Type'] || null, r['E911 Address'] || null, r['Carrier'] || null]
        );
        n++;
      }, e => warnings.push(`DID Numbers "${r['Phone Number']}": ${e.message}`));
    }
    counts.did_numbers = n;

    n = 0;
    for (const r of readSheet(wb, 'Ring Groups')) {
      if (!r['Extension']) continue;
      await trySavepoint(client, async () => {
        await client.query(
          `INSERT INTO phone_ring_groups (extension, description) VALUES ($1,$2)
           ON CONFLICT (extension) DO UPDATE SET description=EXCLUDED.description, updated_at=NOW()`,
          [r['Extension'], r['Description'] || null]
        );
        n++;
      }, e => warnings.push(`Ring Groups "${r['Extension']}": ${e.message}`));
    }
    counts.ring_groups = n;

    n = 0;
    for (const r of readSheet(wb, 'Paging Groups')) {
      if (!r['Page Extension']) continue;
      await trySavepoint(client, async () => {
        await client.query(
          `INSERT INTO phone_paging_groups (page_extension, description, polycom_group_label) VALUES ($1,$2,$3)
           ON CONFLICT (page_extension) DO UPDATE SET description=EXCLUDED.description,
             polycom_group_label=EXCLUDED.polycom_group_label, updated_at=NOW()`,
          [r['Page Extension'], r['Description'] || null, r['Polycom Group Label'] || null]
        );
        n++;
      }, e => warnings.push(`Paging Groups "${r['Page Extension']}": ${e.message}`));
    }
    counts.paging_groups = n;

    n = 0;
    for (const r of readSheet(wb, 'Parking Lots')) {
      if (!r['Location Name']) continue;
      await trySavepoint(client, async () => {
        await client.query(
          `INSERT INTO phone_parking_lots (location_name, extension) VALUES ($1,$2)
           ON CONFLICT (location_name) DO UPDATE SET extension=EXCLUDED.extension, updated_at=NOW()`,
          [r['Location Name'], r['Extension'] || null]
        );
        n++;
      }, e => warnings.push(`Parking Lots "${r['Location Name']}": ${e.message}`));
    }
    counts.parking_lots = n;

    n = 0;
    for (const r of readSheet(wb, 'Extension Rules')) {
      if (!r['Extension Code']) continue;
      await trySavepoint(client, async () => {
        await client.query(
          `INSERT INTO phone_extension_rules (parent_code, extension_code, meaning, sort_order) VALUES ($1,$2,$3,$4)`,
          [r['Parent Code'] || null, r['Extension Code'], r['Meaning'] || null, parseInt(r['Sort Order'], 10) || 0]
        );
        n++;
      }, e => warnings.push(`Extension Rules "${r['Extension Code']}": ${e.message}`));
    }
    counts.extension_rules = n;

    if (commit) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    return { committed: !!commit, counts, warnings };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { buildTemplate, run };
