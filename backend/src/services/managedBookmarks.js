/**
 * Google Admin managed bookmarks sync.
 *
 * Fetches Chrome managed bookmarks from Google Admin API and adds the
 * domains to the allowlist_overrides table so they bypass all DNS blocks.
 *
 * If a site is bookmarked by the admin, it should never be blocked —
 * teachers rely on those being accessible.
 */

const { pool } = require('../db');

async function getGoogleConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('google_client_id','google_client_secret','google_customer_id',
                   'google_workspace_domain')`
  );
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function extractDomains(bookmarks) {
  const domains = new Set();

  function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.url) {
        try {
          const u = new URL(node.url);
          const hostname = u.hostname.replace(/^www\./, '');
          if (hostname && hostname.includes('.')) domains.add(hostname);
        } catch { /* skip invalid URLs */ }
      }
      if (node.children) walk(node.children);
    }
  }

  walk(Array.isArray(bookmarks) ? bookmarks : [bookmarks]);
  return [...domains];
}

async function syncManagedBookmarks(actorId) {
  const keyPath    = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const superadmin = process.env.SUPERADMIN_EMAIL;

  if (!keyPath || !superadmin) {
    throw new Error('Google service account not configured (GOOGLE_SERVICE_ACCOUNT_KEY_PATH + SUPERADMIN_EMAIL env vars required)');
  }

  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes:  ['https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly',
               'https://www.googleapis.com/auth/chrome.management.policy.readonly'],
    clientOptions: { subject: superadmin },
  });

  const cfg        = await getGoogleConfig();
  const customerId = process.env.GOOGLE_CUSTOMER_ID || cfg.google_customer_id || 'my_customer';

  // Fetch managed bookmarks policy value
  const chromepolicy = google.chromepolicy({ version: 'v1', auth });
  const res = await chromepolicy.customers.policies.resolve({
    customer: `customers/${customerId}`,
    requestBody: {
      policySchemaFilter: 'chrome.users.ManagedBookmarks',
      policyTargetKey: { targetResource: `orgunits/${customerId}` },
    },
  });

  const resolvedPolicies = res.data.resolvedPolicies || [];
  const domains = [];

  for (const p of resolvedPolicies) {
    const val = p.value?.value?.ManagedBookmarks;
    if (val) {
      const extracted = extractDomains(val);
      domains.push(...extracted);
    }
  }

  if (domains.length === 0) {
    console.log('[managed-bookmarks] no domains found in managed bookmarks');
    return { added: 0, domains: [] };
  }

  // Upsert to allowlist_overrides
  let added = 0;
  for (const domain of domains) {
    const { rowCount } = await pool.query(
      `INSERT INTO allowlist_overrides (domain, source, notes, added_by)
       VALUES ($1, 'managed_bookmarks', 'Auto-synced from Google Admin managed bookmarks', $2)
       ON CONFLICT (domain) DO UPDATE SET
         source = 'managed_bookmarks',
         added_at = NOW()`,
      [domain, actorId || null]
    );
    added += rowCount;
  }

  console.log(`[managed-bookmarks] synced ${domains.length} domains (${added} new/updated)`);
  return { added, domains };
}

async function getAllowlistDomains() {
  const { rows } = await pool.query(
    `SELECT domain FROM allowlist_overrides ORDER BY domain`
  );
  return rows.map(r => r.domain);
}

module.exports = { syncManagedBookmarks, getAllowlistDomains, extractDomains };
