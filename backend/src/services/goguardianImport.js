// Parses a GoGuardian filter-policy CSV export ("action,url,blocks...") and
// classifies each row into either a DNS-level domain rule (policy_domain_rules)
// or an extension-only URL-path rule (policy_url_rules).
//
// DNS only ever sees a domain, never a path, so anything with a path
// component or an un-collapsible wildcard (e.g. "*.io*" — "contains .io
// anywhere") can only be enforced by the extension via a
// chrome.declarativeNetRequest urlFilter pattern, which GoGuardian's own
// wildcard syntax maps onto almost directly.

const IPV4_RE  = /^\d{1,3}(\.\d{1,3}){3}$/;
const DOMAIN_RE = /^[a-z0-9.-]+$/;

function classifyUrl(rawUrl) {
  const url = rawUrl.trim().toLowerCase();
  if (!url) return { kind: 'skip', reason: 'empty' };
  if (IPV4_RE.test(url)) return { kind: 'skip', reason: 'ip-address' };

  let core = url;
  if (core.startsWith('*.')) core = core.slice(2);
  if (core.endsWith('*'))    core = core.slice(0, -1);

  // A trailing dot means the original had a wildcard TLD (e.g. "*.ck12.*" —
  // "ck12, any TLD") which can't be expressed as one fixed-TLD domain rule;
  // route those to a URL rule instead so the wildcard is preserved.
  const looksLikeDomain = core.includes('.') && !core.endsWith('.') && !core.includes('/') && !core.includes('*') && DOMAIN_RE.test(core);
  if (looksLikeDomain) return { kind: 'domain', value: core };

  return { kind: 'url', value: url };
}

// rows: array of { action, url } (header's third "blocks (last N days)"
// column, if present, is ignored — it's just GoGuardian's own hit-count stat)
function classifyRows(rows) {
  const domainRules = [];
  const urlRules     = [];
  const skipped      = [];

  for (const row of rows) {
    const action = (row.action || '').trim().toLowerCase();
    const rule_type = action === 'block' ? 'deny' : action === 'allow' ? 'allow' : null;
    if (!rule_type) { skipped.push({ ...row, reason: 'unrecognized action' }); continue; }

    const classified = classifyUrl(row.url || '');
    if (classified.kind === 'skip') { skipped.push({ ...row, reason: classified.reason }); continue; }
    if (classified.kind === 'domain') domainRules.push({ domain: classified.value, rule_type });
    else urlRules.push({ pattern: classified.value, rule_type });
  }

  return { domainRules, urlRules, skipped };
}

// Minimal CSV parser — GoGuardian exports are plain comma-separated with no
// quoted/escaped fields, so a naive split is sufficient and avoids pulling in
// a dependency for this one-off import path.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const actionIdx = header.findIndex(h => h === 'action');
  const urlIdx    = header.findIndex(h => h === 'url');
  if (actionIdx === -1 || urlIdx === -1) {
    throw new Error('CSV must have "action" and "url" columns');
  }

  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return { action: cols[actionIdx], url: cols[urlIdx] };
  });
}

module.exports = { classifyUrl, classifyRows, parseCsv };
