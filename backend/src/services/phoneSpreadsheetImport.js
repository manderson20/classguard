// Imports the "Phone System.xlsx" workbook (VoIP phone inventory, caller ID
// identities, DID numbers, ring groups, paging groups, parking lots, and
// extension numbering rules) directly into ClassGuard.
//
// The workbook isn't a clean flat table — most sheets have a merged title
// row above the real header row, some have header columns whose *name* is
// itself the data (e.g. ring-group membership columns named "21000" rather
// than something descriptive). Each sheet gets its own small parser below
// rather than one generic mapper, since the quirks differ sheet to sheet.
//
// Same dry-run pattern as the PHPiPAM dump importer (services/phpipamDumpImport.js):
// everything runs inside one transaction; commit=false rolls back at the end.
// Real-world spreadsheet data has placeholder junk ("N/a" in an IP column,
// etc.) that no amount of upfront sanitizing fully anticipates, so each row
// insert runs inside its own SAVEPOINT — once Postgres aborts a transaction
// on a bad statement, every later statement fails too unless rolled back to
// a savepoint first.

const ExcelJS = require('exceljs');
const { pool } = require('../db');

let spCounter = 0;
// Runs fn() in its own savepoint; on failure, rolls back just that savepoint
// (not the whole transaction) and reports via onError instead of throwing.
async function trySavepoint(client, fn, onError) {
  const sp = `sp_${spCounter++}`;
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

function isTruthy(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'x' || s === 'yes' || s === 'true' || s === '1';
}

// "27003.0" -> "27003", "26051-1" -> unchanged, "Bus Barn" -> unchanged
function stripFloatSuffix(v) {
  if (v === null || v === undefined) return null;
  const m = /^(\d+)\.0+$/.exec(String(v).trim());
  return m ? m[1] : String(v).trim() || null;
}

function formatPhoneNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /[-() ]/.test(value)) return value.trim();
  const digits = String(Math.round(Number(value))).replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  return String(value).trim() || null;
}

function formatMac(raw) {
  if (!raw) return null;
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{1,2}/g).join(':').toUpperCase();
}

// Spreadsheet IP/IP-reservation cells sometimes hold placeholder text
// ("N/a", "-", "TBD") instead of a real address — only pass through values
// that actually look like an IPv4 address, since the column is ::inet typed.
function cleanIp(v) {
  if (!v) return null;
  const s = String(v).trim();
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s) ? s : null;
}

// Builds { headerText -> columnNumber } for a given row.
function headerMap(sheet, rowNum) {
  const map = {};
  sheet.getRow(rowNum).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cellText(cell);
    if (text) map[text] = colNumber;
  });
  return map;
}

// Scans the first few rows for one containing `anchorText` exactly — handles
// sheets that have a merged title row above the real headers and sheets that
// don't, without hardcoding which row is which per sheet.
function findHeaderRow(sheet, anchorText, maxScan = 4) {
  for (let r = 1; r <= maxScan; r++) {
    const row = sheet.getRow(r);
    let found = false;
    row.eachCell({ includeEmpty: false }, cell => { if (cellText(cell) === anchorText) found = true; });
    if (found) return r;
  }
  return null;
}

function pickLatestTermSheet(workbook) {
  let best = null, bestYear = -1;
  workbook.eachSheet(sheet => {
    if (sheet.state !== 'visible') return;
    const m = /^(?:Summer|Winter)\s+(\d{4})$/.exec(sheet.name.trim());
    if (m && parseInt(m[1], 10) > bestYear) { bestYear = parseInt(m[1], 10); best = sheet; }
  });
  return best;
}

function getSheet(workbook, name) {
  const sheet = workbook.getWorksheet(name);
  return sheet && sheet.state === 'visible' ? sheet : null;
}

// ---------------------------------------------------------------------------
// Phones — the term sheet (e.g. "Summer 2026")
// ---------------------------------------------------------------------------
async function importPhones(sheet, client, counts, warnings, sample) {
  const headerRow = findHeaderRow(sheet, 'Device ID');
  if (!headerRow) { warnings.push('Phone roster sheet found, but no "Device ID" column — skipped'); return; }
  const headers = headerMap(sheet, headerRow);

  const pagingCols = [];
  const ringCols   = [];
  const named      = {};
  for (const [text, col] of Object.entries(headers)) {
    const pagingMatch = /\((\d+)\)\s*$/.exec(text);
    if (pagingMatch) { pagingCols.push({ col, ext: pagingMatch[1] }); continue; }
    if (/^\d+(\.0+)?$/.test(text)) { ringCols.push({ col, ext: stripFloatSuffix(text) }); continue; }
    named[text] = col;
  }
  const get = (row, name) => named[name] ? cellText(row.getCell(named[name])) : null;

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const deviceId = get(row, 'Device ID');
    if (!deviceId) continue;

    const pagingGroups = pagingCols.filter(p => isTruthy(cellText(row.getCell(p.col)))).map(p => p.ext);
    const ringGroups   = ringCols.filter(p => isTruthy(cellText(row.getCell(p.col)))).map(p => p.ext);

    const f = {
      device_id: deviceId,
      device_type: get(row, 'Device Type'),
      mac_address: formatMac(get(row, 'MAC Address')),
      ip_address: cleanIp(get(row, 'IP Reservation')),
      network_switch: get(row, 'Network Switch'),
      switch_interface: stripFloatSuffix(get(row, 'Switch Interface')),
      building: get(row, 'Building'),
      room_number: stripFloatSuffix(get(row, 'Room Number')),
      extension: stripFloatSuffix(get(row, 'Phone Extension')),
      display_name: get(row, 'Name/Caller ID'),
      voicemail_email: get(row, 'Voicemail - Email Address'),
      leave_voicemail_on_server: get(row, 'Leave Voicemail on Phone Server'),
      egress_outside_number: get(row, 'Egress Outside Phone Number'),
      outbound_egress_cid: get(row, 'Outbound Egress CID'),
      ingress_phone_number: get(row, 'Ingress Phone Number'),
      emergency_egress_cid: get(row, 'Emergency Egress CID'),
      sidecar_needed: isTruthy(get(row, 'Sidecar Needed')),
      sidecar_serial: get(row, 'Sidecar Serial Number'),
      sidecar_model: get(row, 'Sidecar Model'),
      headset_needed: isTruthy(get(row, 'Head Set Needed')),
      headset_model: get(row, 'Head Set Model'),
      wall_mount_needed: isTruthy(get(row, 'Wall Mount Needed')),
      wall_mount_model: get(row, 'Wall Mount Model'),
      handset_needed: isTruthy(get(row, 'Hand Set Needed')),
      handset_model: get(row, 'Hand Set Model'),
    };

    await trySavepoint(client, async () => {
      await client.query(
        `INSERT INTO phones (device_id, device_type, mac_address, ip_address, network_switch, switch_interface,
            building, room_number, extension, display_name, voicemail_email, leave_voicemail_on_server,
            egress_outside_number, outbound_egress_cid, ingress_phone_number, emergency_egress_cid,
            paging_groups, ring_groups, sidecar_needed, sidecar_serial, sidecar_model,
            headset_needed, headset_model, wall_mount_needed, wall_mount_model, handset_needed, handset_model)
         VALUES ($1,$2,$3::macaddr,$4::inet,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         ON CONFLICT (device_id) DO UPDATE SET
           device_type=EXCLUDED.device_type, mac_address=EXCLUDED.mac_address, ip_address=EXCLUDED.ip_address,
           network_switch=EXCLUDED.network_switch, switch_interface=EXCLUDED.switch_interface,
           building=EXCLUDED.building, room_number=EXCLUDED.room_number, extension=EXCLUDED.extension,
           display_name=EXCLUDED.display_name, voicemail_email=EXCLUDED.voicemail_email,
           leave_voicemail_on_server=EXCLUDED.leave_voicemail_on_server,
           egress_outside_number=EXCLUDED.egress_outside_number, outbound_egress_cid=EXCLUDED.outbound_egress_cid,
           ingress_phone_number=EXCLUDED.ingress_phone_number, emergency_egress_cid=EXCLUDED.emergency_egress_cid,
           paging_groups=EXCLUDED.paging_groups, ring_groups=EXCLUDED.ring_groups,
           sidecar_needed=EXCLUDED.sidecar_needed, sidecar_serial=EXCLUDED.sidecar_serial, sidecar_model=EXCLUDED.sidecar_model,
           headset_needed=EXCLUDED.headset_needed, headset_model=EXCLUDED.headset_model,
           wall_mount_needed=EXCLUDED.wall_mount_needed, wall_mount_model=EXCLUDED.wall_mount_model,
           handset_needed=EXCLUDED.handset_needed, handset_model=EXCLUDED.handset_model,
           updated_at=NOW()`,
        [f.device_id, f.device_type, f.mac_address, f.ip_address, f.network_switch, f.switch_interface,
         f.building, f.room_number, f.extension, f.display_name, f.voicemail_email, f.leave_voicemail_on_server,
         f.egress_outside_number, f.outbound_egress_cid, f.ingress_phone_number, f.emergency_egress_cid,
         JSON.stringify(pagingGroups), JSON.stringify(ringGroups),
         f.sidecar_needed, f.sidecar_serial, f.sidecar_model,
         f.headset_needed, f.headset_model, f.wall_mount_needed, f.wall_mount_model,
         f.handset_needed, f.handset_model]
      );
      counts.phones++;
      if (sample.phones.length < 5) sample.phones.push({ device_id: f.device_id, extension: f.extension, display_name: f.display_name });
    }, e => warnings.push(`Phone ${deviceId}: ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// Caller ID profiles — "Phone Numbers" sheet
// ---------------------------------------------------------------------------
async function importCallerIdProfiles(sheet, client, counts, warnings, sample) {
  const headerRow = findHeaderRow(sheet, 'Caller ID');
  if (!headerRow) return;
  const h = headerMap(sheet, headerRow);
  const get = (row, name) => h[name] ? cellText(row.getCell(h[name])) : null;

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const name = get(row, 'Caller ID');
    if (!name) continue;
    await trySavepoint(client, async () => {
      await client.query(
        `INSERT INTO phone_caller_id_profiles (caller_id_name, building_department, address, phone_number, fax_number, connection_type, e911_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (caller_id_name) DO UPDATE SET
           building_department=EXCLUDED.building_department, address=EXCLUDED.address,
           phone_number=EXCLUDED.phone_number, fax_number=EXCLUDED.fax_number,
           connection_type=EXCLUDED.connection_type, e911_address=EXCLUDED.e911_address, updated_at=NOW()`,
        [name, get(row, 'Building/Department'), get(row, 'Address'),
         formatPhoneNumber(get(row, 'Phone Number')), formatPhoneNumber(get(row, 'Fax Number')),
         get(row, 'VoIP/Analog Connection'), get(row, 'VoIP e911 Address')]
      );
      counts.callerIdProfiles++;
      if (sample.callerIdProfiles.length < 5) sample.callerIdProfiles.push({ name });
    }, e => warnings.push(`Caller ID profile "${name}": ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// DID numbers — "DID Provider" sheet
// ---------------------------------------------------------------------------
async function importDidNumbers(sheet, client, counts, warnings, sample) {
  const headerRow = findHeaderRow(sheet, 'Phone Number');
  if (!headerRow) return;
  const h = headerMap(sheet, headerRow);
  const get = (row, name) => h[name] ? cellText(row.getCell(h[name])) : null;

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const phoneNumber = formatPhoneNumber(get(row, 'Phone Number'));
    if (!phoneNumber) continue;
    const rawType = (get(row, 'Phone/Fax') || '').toLowerCase();
    await trySavepoint(client, async () => {
      await client.query(
        `INSERT INTO phone_did_numbers (phone_number, description, number_type, connection_type, e911_address, carrier)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (phone_number) DO UPDATE SET
           description=EXCLUDED.description, number_type=EXCLUDED.number_type,
           connection_type=EXCLUDED.connection_type, e911_address=EXCLUDED.e911_address, carrier=EXCLUDED.carrier, updated_at=NOW()`,
        [phoneNumber, get(row, 'Description'), rawType.includes('fax') ? 'fax' : 'phone',
         get(row, 'VoIP/Analog'), get(row, '911 Address'), get(row, 'Phone Service Carrier')]
      );
      counts.didNumbers++;
      if (sample.didNumbers.length < 5) sample.didNumbers.push({ phoneNumber });
    }, e => warnings.push(`DID ${phoneNumber}: ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// Ring groups — "Ring Groups" sheet
// ---------------------------------------------------------------------------
async function importRingGroups(sheet, client, counts, warnings, sample) {
  const headerRow = findHeaderRow(sheet, 'Ring Group Extension');
  if (!headerRow) return;
  const h = headerMap(sheet, headerRow);
  const get = (row, name) => h[name] ? cellText(row.getCell(h[name])) : null;

  const memberCols = [];
  for (const [text, col] of Object.entries(h)) {
    const m = /^Extension (\d+)$/.exec(text);
    if (m) {
      const descCol = h[`Description ${m[1]}`];
      if (descCol) memberCols.push({ extCol: col, descCol });
    }
  }

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const extension = stripFloatSuffix(get(row, 'Ring Group Extension'));
    if (!extension) continue;
    const members = memberCols
      .map(m => ({ extension: stripFloatSuffix(cellText(row.getCell(m.extCol))), description: cellText(row.getCell(m.descCol)) }))
      .filter(m => m.extension);

    await trySavepoint(client, async () => {
      await client.query(
        `INSERT INTO phone_ring_groups (extension, description, members)
         VALUES ($1,$2,$3)
         ON CONFLICT (extension) DO UPDATE SET description=EXCLUDED.description, members=EXCLUDED.members, updated_at=NOW()`,
        [extension, get(row, 'Description'), JSON.stringify(members)]
      );
      counts.ringGroups++;
      if (sample.ringGroups.length < 5) sample.ringGroups.push({ extension, description: get(row, 'Description'), members: members.length });
    }, e => warnings.push(`Ring group ${extension}: ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// Paging groups — "Multicast Zones" (the network side) joined with
// "Page Group Extensions" (the dial-code side) on extension number. The
// network side is also mirrored into multicast_groups (shared with IPAM)
// rather than duplicated, since multiple page extensions can legitimately
// share one physical multicast zone (e.g. different bell-schedule codes
// all ringing the same MS zone).
// ---------------------------------------------------------------------------
async function importPagingGroups(zonesSheet, extSheet, client, counts, warnings, sample) {
  const extByCode = {};
  if (extSheet) {
    const headerRow = findHeaderRow(extSheet, 'Page Extension');
    if (headerRow) {
      const h = headerMap(extSheet, headerRow);
      for (let r = headerRow + 1; r <= extSheet.rowCount; r++) {
        const row = extSheet.getRow(r);
        const code = stripFloatSuffix(cellText(row.getCell(h['Page Extension'])));
        if (!code || !/^\d+$/.test(code)) continue;
        extByCode[code] = {
          description: h['Description'] ? cellText(row.getCell(h['Description'])) : null,
          label: h['Multicast Paging Group'] ? cellText(row.getCell(h['Multicast Paging Group'])) : null,
        };
      }
    }
  }

  if (!zonesSheet) return;
  const headerRow = findHeaderRow(zonesSheet, 'Description/Zone');
  if (!headerRow) { warnings.push('Multicast Zones sheet found, but headers did not match expected layout — skipped'); return; }
  const h = headerMap(zonesSheet, headerRow);
  // The multicast-address column has no reliable header text of its own
  // ("..") — it's always the leftmost named column in this sheet.
  const addressCol = Math.min(...Object.values(h));

  const multicastIdByAddress = {};
  const seenCodes = new Set();

  for (let r = headerRow + 1; r <= zonesSheet.rowCount; r++) {
    const row = zonesSheet.getRow(r);
    const code = stripFloatSuffix(cellText(row.getCell(h['Extension'])));
    if (!code || !/^\d+$/.test(code)) continue;

    const rawAddr = cellText(row.getCell(addressCol)); // e.g. "239.0.1.10:5001" or "N/a"
    const zoneDescription = h['Description/Zone'] ? cellText(row.getCell(h['Description/Zone'])) : null;
    const notes = h['Notes'] ? cellText(row.getCell(h['Notes'])) : null;
    const matched = extByCode[code];

    let multicastGroupId = null;
    const addrMatch = rawAddr && /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d+))?$/.exec(rawAddr.trim());
    if (addrMatch) {
      const address = addrMatch[1];
      const port    = addrMatch[2] ? parseInt(addrMatch[2], 10) : null;
      if (!multicastIdByAddress[address]) {
        await trySavepoint(client, async () => {
          const { rows } = await client.query(
            `INSERT INTO multicast_groups (group_address, name, description, application, port)
             VALUES ($1::inet,$2,$3,'voip_paging',$4)
             ON CONFLICT (group_address) DO UPDATE SET updated_at = NOW()
             RETURNING id`,
            [address, zoneDescription || address, zoneDescription, port]
          );
          multicastIdByAddress[address] = rows[0].id;
        }, e => warnings.push(`Multicast zone ${address}: ${e.message}`));
      }
      multicastGroupId = multicastIdByAddress[address] || null;
    }

    await trySavepoint(client, async () => {
      await client.query(
        `INSERT INTO phone_paging_groups (page_extension, description, polycom_group_label, multicast_group_id, notes)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (page_extension) DO UPDATE SET
           description=EXCLUDED.description, polycom_group_label=EXCLUDED.polycom_group_label,
           multicast_group_id=EXCLUDED.multicast_group_id, notes=EXCLUDED.notes, updated_at=NOW()`,
        [code, matched?.description || zoneDescription, matched?.label || null, multicastGroupId, notes]
      );
      seenCodes.add(code);
      counts.pagingGroups++;
      if (sample.pagingGroups.length < 5) sample.pagingGroups.push({ page_extension: code, description: matched?.description || zoneDescription });
    }, e => warnings.push(`Paging group ${code}: ${e.message}`));
  }

  // Page Group Extensions entries with no Multicast Zones row at all (e.g. reserved/unused codes)
  for (const [code, info] of Object.entries(extByCode)) {
    if (seenCodes.has(code)) continue;
    await trySavepoint(client, async () => {
      await client.query(
        `INSERT INTO phone_paging_groups (page_extension, description, polycom_group_label)
         VALUES ($1,$2,$3)
         ON CONFLICT (page_extension) DO NOTHING`,
        [code, info.description, info.label]
      );
      counts.pagingGroups++;
    }, e => warnings.push(`Paging group ${code}: ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// Call parking lots
// ---------------------------------------------------------------------------
async function importParkingLots(sheet, client, counts, warnings, sample) {
  const headerRow = findHeaderRow(sheet, 'Parking Lots');
  if (!headerRow) return;
  const h = headerMap(sheet, headerRow);
  const lotCols = Object.entries(h).filter(([text]) => /^Lot Number \d+$/.test(text)).map(([, col]) => col);

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const name = cellText(row.getCell(h['Parking Lots']));
    if (!name) continue;
    const lots = lotCols.map(c => stripFloatSuffix(cellText(row.getCell(c)))).filter(Boolean);
    await trySavepoint(client, async () => {
      await client.query(
        `INSERT INTO phone_parking_lots (location_name, extension, lot_numbers)
         VALUES ($1,$2,$3)
         ON CONFLICT (location_name) DO UPDATE SET extension=EXCLUDED.extension, lot_numbers=EXCLUDED.lot_numbers, updated_at=NOW()`,
        [name, stripFloatSuffix(cellText(row.getCell(h['Extension']))), JSON.stringify(lots)]
      );
      counts.parkingLots++;
      if (sample.parkingLots.length < 5) sample.parkingLots.push({ name, lots: lots.length });
    }, e => warnings.push(`Parking lot "${name}": ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// Extension numbering rules — reference data, replaced wholesale each import
// ---------------------------------------------------------------------------
async function importExtensionRules(sheet, client, counts, warnings) {
  const headerRow = findHeaderRow(sheet, 'Parent Extension Code');
  if (!headerRow) return;
  const h = headerMap(sheet, headerRow);

  await client.query('DELETE FROM phone_extension_rules');
  let order = 0;
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const extCode = cellText(row.getCell(h['Extension Code']));
    if (!extCode) continue;
    await trySavepoint(client, async () => {
      await client.query(
        `INSERT INTO phone_extension_rules (parent_code, extension_code, meaning, sort_order) VALUES ($1,$2,$3,$4)`,
        [cellText(row.getCell(h['Parent Extension Code'])), extCode, cellText(row.getCell(h['Meaning (2nd Digit is building number)'])), order++]
      );
      counts.extensionRules++;
    }, e => warnings.push(`Extension rule "${extCode}": ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
async function run(buffer, commit) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const termSheet = pickLatestTermSheet(workbook);
  if (!termSheet) throw new Error('No "Summer YYYY" / "Winter YYYY" phone roster sheet found — is this the Phone System workbook?');

  const warnings = [];
  const sample = { phones: [], callerIdProfiles: [], didNumbers: [], ringGroups: [], pagingGroups: [], parkingLots: [] };
  const counts = {
    phones: 0, callerIdProfiles: 0, didNumbers: 0, ringGroups: 0, pagingGroups: 0, parkingLots: 0, extensionRules: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await importPhones(termSheet, client, counts, warnings, sample);
    await importCallerIdProfiles(getSheet(workbook, 'Phone Numbers'), client, counts, warnings, sample);
    await importDidNumbers(getSheet(workbook, 'DID Provider'), client, counts, warnings, sample);
    await importRingGroups(getSheet(workbook, 'Ring Groups'), client, counts, warnings, sample);
    await importPagingGroups(getSheet(workbook, 'Multicast Zones'), getSheet(workbook, 'Page Group Extensions'), client, counts, warnings, sample);
    await importParkingLots(getSheet(workbook, 'Call Parking Lots'), client, counts, warnings, sample);
    await importExtensionRules(getSheet(workbook, 'Phone Extension Rules'), client, counts, warnings);

    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');

    return { committed: !!commit, termSheetName: termSheet.name, counts, warnings, sample };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { run };
