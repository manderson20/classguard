/**
 * PHPiPAM Import Service
 *
 * Uses the PHPiPAM REST API to export subnets, IP addresses, VLANs, VRFs,
 * and sections, then imports them into ClassGuard's IPAM tables.
 *
 * PHPiPAM API authentication:
 *   POST /api/{app_id}/user/ with username+password → returns token
 *   Subsequent requests: Authorization: Token <token>
 */

const axios  = require('axios');
const { pool } = require('../db');

async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('phpipam_url','phpipam_app_id','phpipam_username','phpipam_password')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    url:      process.env.PHPIPAM_URL      || cfg.phpipam_url      || null,
    appId:    process.env.PHPIPAM_APP_ID   || cfg.phpipam_app_id   || null,
    username: process.env.PHPIPAM_USERNAME || cfg.phpipam_username || null,
    password: process.env.PHPIPAM_PASSWORD || cfg.phpipam_password || null,
  };
}

async function authenticate(cfg) {
  const res = await axios.post(
    `${cfg.url.replace(/\/$/, '')}/api/${cfg.appId}/user/`,
    {},
    {
      auth:    { username: cfg.username, password: cfg.password },
      timeout: 10_000,
    }
  );
  if (!res.data?.data?.token) throw new Error('PHPiPAM authentication failed');
  return res.data.data.token;
}

function buildClient(cfg, token) {
  return axios.create({
    baseURL: `${cfg.url.replace(/\/$/, '')}/api/${cfg.appId}`,
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Full import — run in background, stream progress via events
// ---------------------------------------------------------------------------
async function runImport(onProgress = () => {}) {
  const cfg = await getConfig();
  if (!cfg.url || !cfg.appId || !cfg.username || !cfg.password) {
    throw new Error('PHPiPAM connection not configured. Set credentials in Settings → Integrations.');
  }

  const token  = await authenticate(cfg);
  const http   = buildClient(cfg, token);
  const report = { sections: 0, vrfs: 0, vlans: 0, subnets: 0, addresses: 0, errors: [] };

  // -- Sections --
  onProgress('Importing sections…');
  try {
    const { data } = await http.get('/sections/');
    for (const s of (data.data || [])) {
      await pool.query(
        `INSERT INTO ipam_sections (name, description)
         VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [s.name, s.description || null]
      ).catch(() => {});
      report.sections++;
    }
  } catch (e) { report.errors.push(`sections: ${e.message}`); }

  // -- VRFs --
  onProgress('Importing VRFs…');
  try {
    const { data } = await http.get('/vrf/');
    for (const v of (data.data || [])) {
      await pool.query(
        `INSERT INTO vrfs (name, rd, description)
         VALUES ($1,$2,$3)
         ON CONFLICT (name) DO UPDATE SET rd = EXCLUDED.rd, description = EXCLUDED.description`,
        [v.name, v.rd || null, v.description || null]
      ).catch(() => {});
      report.vrfs++;
    }
  } catch (e) { report.errors.push(`vrfs: ${e.message}`); }

  // -- VLANs --
  onProgress('Importing VLANs…');
  try {
    const { data } = await http.get('/vlan/');
    for (const v of (data.data || [])) {
      await pool.query(
        `INSERT INTO vlans (vlan_id, name, description)
         VALUES ($1,$2,$3)
         ON CONFLICT (vlan_id) DO UPDATE SET name = EXCLUDED.name`,
        [parseInt(v.vlanId || v.number, 10), v.name, v.description || null]
      ).catch(() => {});
      report.vlans++;
    }
  } catch (e) { report.errors.push(`vlans: ${e.message}`); }

  // -- Subnets --
  onProgress('Importing subnets…');
  try {
    const { data } = await http.get('/subnets/cidr/');
    const subnets  = data.data || [];

    // Also try the full list endpoint
    const { data: allData } = await http.get('/subnets/').catch(() => ({ data: { data: [] } }));
    const allSubnets = allData.data || [];
    const combined  = [...new Map([...subnets, ...allSubnets].map(s => [s.id, s])).values()];

    for (const s of combined) {
      if (!s.subnet || !s.mask) continue;
      const cidr = `${s.subnet}/${s.mask}`;
      try {
        const ipVersion = cidr.includes(':') ? 6 : 4;
        await pool.query(
          `INSERT INTO ipam_subnets (subnet, ip_version, name, description, gateway, notes)
           VALUES ($1::cidr,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [cidr, ipVersion, s.sectionId ? `[${s.sectionId}] ${s.description}` : s.description,
           s.description, s.gateway || null, s.deviceId || null]
        );
        report.subnets++;
      } catch (e) { report.errors.push(`subnet ${cidr}: ${e.message}`); }
    }
  } catch (e) { report.errors.push(`subnets: ${e.message}`); }

  // -- IP Addresses --
  onProgress('Importing IP addresses (this may take a while)…');
  try {
    const { data } = await http.get('/addresses/').catch(() => ({ data: { data: [] } }));
    for (const a of (data.data || [])) {
      if (!a.ip) continue;
      const status = a.state === '0' ? 'free' :
                     a.state === '2' ? 'reserved' :
                     a.state === '3' ? 'offline' : 'used';
      try {
        await pool.query(
          `INSERT INTO ip_addresses (ip, hostname, description, mac_address, owner, status, notes)
           VALUES ($1,$2,$3,$4::macaddr,$5,$6,$7)
           ON CONFLICT (ip) DO NOTHING`,
          [a.ip, a.hostname || null, a.description || null,
           a.mac ? a.mac.replace(/-/g, ':') : null,
           a.owner || null, status, a.note || null]
        );
        report.addresses++;
      } catch (e) { report.errors.push(`address ${a.ip}: ${e.message}`); }
    }
  } catch (e) { report.errors.push(`addresses: ${e.message}`); }

  // Revoke token
  await http.delete('/user/').catch(() => {});

  onProgress(`Import complete: ${report.subnets} subnets, ${report.addresses} addresses.`);
  return report;
}

module.exports = { getConfig, runImport };
