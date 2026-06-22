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

// One DNS label: 1–63 chars, alphanumeric, hyphens allowed but never
// leading/trailing (matches the real DNS label grammar, not just "looks
// domain-ish") — catches things like "..", "-foo.com", "foo-.com".
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidDomain(core) {
  if (!core || core.length > 253) return false;
  const labels = core.split('.');
  if (labels.length < 2) return false; // needs at least a name + TLD
  if (!labels.every(label => LABEL_RE.test(label))) return false;
  const tld = labels[labels.length - 1];
  return tld.length >= 2 && /^[a-z]/.test(tld); // TLDs are never all-numeric or 1 char
}

// Characters a Chrome declarativeNetRequest urlFilter pattern is allowed to
// use: standard URL characters, plus '*' (wildcard) and '^' (DNR separator)
// and a leading/trailing '|' (DNR anchor). See
// https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#filter-syntax
// Whitespace/quotes/angle-brackets are never legitimate here — they're the
// reliable signal of a typo or pasted garbage, not a real pattern. A bad
// pattern here doesn't just silently fail to match — it makes Chrome's own
// updateDynamicRules() throw and reject the *entire* rule batch, so this is
// worth catching before it ever reaches the extension.
const URL_PATTERN_RE = /^[a-z0-9.\-_~:/?#@!$&'()+,;=%*^|]+$/;

function isValidUrlPattern(pattern) {
  const p = (pattern || '').trim();
  return p.length > 0 && p.length <= 2000 && URL_PATTERN_RE.test(p);
}

function classifyUrl(rawUrl) {
  const url = rawUrl.trim().toLowerCase();
  if (!url) return { kind: 'skip', reason: 'empty' };
  if (IPV4_RE.test(url)) return { kind: 'skip', reason: 'ip-address' };

  let core = url;
  if (core.startsWith('*.')) core = core.slice(2);
  if (core.endsWith('*'))    core = core.slice(0, -1);

  // (A wildcard TLD like "*.ck12.*" strips down to "ck12." here, which
  // isValidDomain rejects on its own — empty trailing label — so it falls
  // through to the URL-pattern branch below without needing a special case.)
  const looksLikeDomain = core.includes('.') && !core.includes('/') && !core.includes('*') && isValidDomain(core);
  if (looksLikeDomain) return { kind: 'domain', value: core };

  if (!isValidUrlPattern(url)) {
    return { kind: 'invalid', reason: `"${rawUrl.trim()}" isn't a valid domain or URL pattern` };
  }
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
    if (classified.kind === 'skip' || classified.kind === 'invalid') {
      skipped.push({ ...row, reason: classified.reason }); continue;
    }
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

module.exports = { classifyUrl, classifyRows, parseCsv, isValidDomain, isValidUrlPattern };
