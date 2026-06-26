const { pool } = require('../db');

// ---------------------------------------------------------------------------
// Merges integration_devices rows from different sources (Snipe-IT, Mosyle,
// Google Chromebooks) that represent the same physical device into one
// record, then overlays live network presence from network_clients (UniFi).
//
// Match key is serial number — the one identifier all three MDM/inventory
// sources actually provide (Snipe-IT has no MAC/IP at all; it's pure asset
// inventory). Network presence is matched separately by MAC, since that's
// the only identifier network_clients has. A device with no serial number
// anywhere just becomes its own singleton group rather than being dropped.
//
// Snipe-IT has no MAC/serial data on it, so it's never used as a network
// match target — only as a possible *source* of serial number for the group.
// ---------------------------------------------------------------------------

function normalizeMac(mac) {
  return (mac || '').toString().replace(/[^0-9a-f]/gi, '').toLowerCase();
}

function normalizeSerial(serial) {
  return (serial || '').toString().trim().toUpperCase();
}

// Different sources are authoritative for different things: Snipe-IT is the
// system of record for asset/ownership/checkout state; the MDM sources
// (Mosyle/Google) are authoritative for live technical state because
// they're the device reporting in about itself, not a human typing it in.
const ASSET_FIELD_SOURCES = ['snipeit', 'mosyle', 'google_admin'];
const TECH_FIELD_SOURCES  = ['mosyle', 'google_admin', 'snipeit'];

function pickField(rowsBySource, field, order) {
  for (const src of order) {
    const v = rowsBySource[src]?.[field];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

async function getUnifiedDevices() {
  const [{ rows: devices }, { rows: clients }] = await Promise.all([
    pool.query('SELECT * FROM integration_devices'),
    pool.query(
      `SELECT mac, ip_address, hostname, ap_name, ssid, status, last_seen
       FROM network_clients`
    ),
  ]);

  const networkByMac = new Map();
  for (const c of clients) networkByMac.set(normalizeMac(c.mac), c);

  const groups = new Map();
  for (const d of devices) {
    const serial = normalizeSerial(d.serial_number);
    const key    = serial || `__row__${d.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  const unified = [];
  for (const [key, rows] of groups) {
    // If duplicate (source, serial) somehow occurs, last one wins for that source's slot — fine, both are the same source's view of this device.
    const rowsBySource = Object.fromEntries(rows.map(r => [r.source, r]));
    const macs = [...new Set(rows.flatMap(r => r.mac_addresses || []).filter(Boolean))];
    const ips  = [...new Set(rows.flatMap(r => r.ip_addresses || []).filter(Boolean))];

    let network = null;
    for (const mac of macs) {
      const match = networkByMac.get(normalizeMac(mac));
      if (match) { network = match; break; }
    }

    unified.push({
      key,
      serialNumber:  pickField(rowsBySource, 'serial_number', ASSET_FIELD_SOURCES) || rows[0].serial_number || null,
      deviceName:    pickField(rowsBySource, 'device_name',   TECH_FIELD_SOURCES),
      deviceModel:   pickField(rowsBySource, 'device_model',  TECH_FIELD_SOURCES),
      osType:        pickField(rowsBySource, 'os_type',       TECH_FIELD_SOURCES),
      osVersion:     pickField(rowsBySource, 'os_version',    TECH_FIELD_SOURCES),
      assignedEmail: pickField(rowsBySource, 'assigned_email', ASSET_FIELD_SOURCES),
      assignedUser:  pickField(rowsBySource, 'assigned_user',  ASSET_FIELD_SOURCES),
      status:        pickField(rowsBySource, 'status',        ASSET_FIELD_SOURCES),
      location:      pickField(rowsBySource, 'location',      ASSET_FIELD_SOURCES),
      assetTag:      pickField(rowsBySource, 'asset_tag',     ASSET_FIELD_SOURCES),
      macAddresses:  macs,
      ipAddresses:   ips,
      sources:       rows.map(r => ({ source: r.source, id: r.id, externalId: r.external_id, syncedAt: r.synced_at })),
      network:       network ? {
        mac: network.mac, ip: network.ip_address, hostname: network.hostname,
        apName: network.ap_name, ssid: network.ssid, status: network.status, lastSeen: network.last_seen,
      } : null,
      lastSynced: rows.reduce((max, r) => (!max || (r.synced_at && r.synced_at > max)) ? r.synced_at : max, null),
    });
  }

  return unified;
}

module.exports = { getUnifiedDevices, normalizeMac, normalizeSerial };
