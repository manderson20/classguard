/**
 * Apple OS version sync via the SOFA feed (Mac Admins community project).
 * Fetches current iOS/iPadOS and macOS versions daily so fleet-health
 * comparisons don't require manual reference table edits.
 *
 * Feed URLs (no auth, public):
 *   https://sofafeed.macadmins.io/v1/ios_data_feed.json
 *   https://sofafeed.macadmins.io/v1/macos_data_feed.json
 *
 * Each feed returns { OSVersions: [ { Latest: { ProductVersion: "..." } }, … ] }
 * with the newest version first. The same iOS feed covers both iOS and iPadOS.
 */

const axios  = require('axios');
const { pool } = require('../db');

const SOFA_IOS_URL   = 'https://sofafeed.macadmins.io/v1/ios_data_feed.json';
const SOFA_MACOS_URL = 'https://sofafeed.macadmins.io/v1/macos_data_feed.json';
const TIMEOUT_MS     = 15_000;

async function syncAppleOsVersions() {
  let iosVersion   = null;
  let macosVersion = null;

  try {
    const { data } = await axios.get(SOFA_IOS_URL, { timeout: TIMEOUT_MS });
    iosVersion = data?.OSVersions?.[0]?.Latest?.ProductVersion || null;
  } catch (err) {
    console.error('[appleOsSync] iOS SOFA feed fetch failed:', err.message);
  }

  try {
    const { data } = await axios.get(SOFA_MACOS_URL, { timeout: TIMEOUT_MS });
    macosVersion = data?.OSVersions?.[0]?.Latest?.ProductVersion || null;
  } catch (err) {
    console.error('[appleOsSync] macOS SOFA feed fetch failed:', err.message);
  }

  if (iosVersion) {
    await pool.query(
      `UPDATE apple_os_reference
       SET latest_version=$1, notes='Auto-synced from SOFA feed', updated_at=NOW()
       WHERE os_family='iOS'`,
      [iosVersion]
    );
    await pool.query(
      `UPDATE apple_os_reference
       SET latest_version=$1, notes='Auto-synced from SOFA feed', updated_at=NOW()
       WHERE os_family='iPadOS'`,
      [iosVersion]
    );
  }

  if (macosVersion) {
    await pool.query(
      `UPDATE apple_os_reference
       SET latest_version=$1, notes='Auto-synced from SOFA feed', updated_at=NOW()
       WHERE os_family='macOS'`,
      [macosVersion]
    );
  }

  console.log('[appleOsSync] synced — iOS/iPadOS:', iosVersion, '| macOS:', macosVersion);

  return { ios: iosVersion, ipados: iosVersion, macos: macosVersion };
}

module.exports = { syncAppleOsVersions };
