// Keeps phones visible in IPAM: when a phone has an ip_address, find-or-create
// a matching ip_addresses row so it shows up in subnet utilization / device
// views like any other tracked device, instead of living only in the phones
// table. Existing manually-entered IPAM rows are never overwritten — we only
// fill in data on rows we created ourselves (tagged 'phone-system').
const { query } = require('../db');

const TAG = 'phone-system';

async function syncPhone(phone) {
  // Phone's IP cleared or never set — drop the link, clean up an auto-row
  // we created (never touch one we don't own).
  if (!phone.ip_address) {
    if (phone.ipam_address_id) {
      await query(
        `DELETE FROM ip_addresses WHERE id = $1 AND $2 = ANY(tags)`,
        [phone.ipam_address_id, TAG]
      );
      const { rows: [updated] } = await query(
        `UPDATE phones SET ipam_address_id = NULL WHERE id = $1 RETURNING *`,
        [phone.id]
      );
      return updated;
    }
    return phone;
  }

  // INSERT-first with ON CONFLICT (ip) DO NOTHING instead of a SELECT-then-
  // INSERT — the old check-then-act pattern raced two concurrent syncPhone()
  // calls landing on the same IP (both see "not existing", both try to
  // INSERT, one throws an uncaught duplicate-key error). ip_addresses.ip has
  // its own UNIQUE constraint, so this closes the race atomically; if the
  // conflict fires, fetch the row that already won.
  const { rows: [created] } = await query(
    `INSERT INTO ip_addresses (ip, hostname, device_type, mac_address, owner, tags)
     VALUES ($1, $2, 'voip', $3, $4, ARRAY[$5])
     ON CONFLICT (ip) DO NOTHING
     RETURNING *`,
    [phone.ip_address, phone.display_name, phone.mac_address || null,
     [phone.building, phone.room_number].filter(Boolean).join(' - ') || null, TAG]
  );

  let ipamId;
  if (created) {
    ipamId = created.id;
  } else {
    const { rows: [existing] } = await query(
      `SELECT * FROM ip_addresses WHERE ip = $1`,
      [phone.ip_address]
    );
    ipamId = existing.id;
    // Only keep our own auto-created rows in sync — never clobber a manually
    // entered IPAM record that happens to share this IP.
    if (existing.tags?.includes(TAG)) {
      await query(
        `UPDATE ip_addresses SET hostname=$1, device_type='voip', mac_address=$2, owner=$3, updated_at=NOW()
         WHERE id=$4`,
        [phone.display_name, phone.mac_address || null,
         [phone.building, phone.room_number].filter(Boolean).join(' - ') || null, ipamId]
      );
    }
  }

  // Phone moved to a different IP — clean up the old auto-row if we own it
  // and nothing else has since linked to it.
  if (phone.ipam_address_id && phone.ipam_address_id !== ipamId) {
    await query(
      `DELETE FROM ip_addresses WHERE id = $1 AND $2 = ANY(tags)`,
      [phone.ipam_address_id, TAG]
    );
  }

  if (phone.ipam_address_id === ipamId) return phone;

  const { rows: [updated] } = await query(
    `UPDATE phones SET ipam_address_id = $1 WHERE id = $2 RETURNING *`,
    [ipamId, phone.id]
  );
  return updated;
}

module.exports = { syncPhone };
