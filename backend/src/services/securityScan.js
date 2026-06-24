// Dependency vulnerability scanning for the backend's own npm packages,
// cross-referenced against CISA's Known Exploited Vulnerabilities (KEV)
// catalog. Scoped to backend deps specifically (zero new container
// privilege needed -- this runs npm audit against the api container's
// own already-present package-lock.json) rather than OS-level packages in
// the Postgres/Redis/nginx/Kea images, which would need Docker socket
// access to scan and was deliberately left out of this first version.
// Frontend npm deps are covered separately by GitHub Dependabot on the repo.
//
// Honest limitation: CISA KEV is almost entirely enterprise/network-
// appliance CVEs (Citrix, Fortinet, Exchange, etc.), not application-level
// npm libraries -- a KEV match here will be rare. The cross-reference is
// still correct to do (and free), just don't expect it to fire often.
const { execSync } = require('child_process');
const axios  = require('axios');
const { pool } = require('../db');

const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

async function fetchKevCveSet() {
  try {
    const { data } = await axios.get(KEV_URL, { timeout: 10_000 });
    const map = new Map(data.vulnerabilities.map(v => [v.cveID, v.dueDate]));
    return map;
  } catch (err) {
    console.error('[securityScan] could not fetch CISA KEV catalog:', err.message);
    return new Map(); // scan still proceeds, just without KEV flags
  }
}

// GHSA-id -> CVE-id mapping rarely changes once published -- cached per
// scan run (a handful of unique advisories at most) to stay well under
// GitHub's unauthenticated 60 req/hour rate limit.
async function lookupGhsaCve(ghsaId, cache) {
  if (cache.has(ghsaId)) return cache.get(ghsaId);
  try {
    const { data } = await axios.get(`https://api.github.com/advisories/${ghsaId}`, { timeout: 8_000 });
    cache.set(ghsaId, data.cve_id || null);
  } catch {
    cache.set(ghsaId, null);
  }
  return cache.get(ghsaId);
}

function runNpmAudit() {
  try {
    // npm audit exits non-zero when it finds vulnerabilities -- that's
    // not a failure of the SCAN, it's the expected outcome when there
    // are findings, so capture stdout regardless of exit code.
    const out = execSync('npm audit --json', { cwd: '/app', encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

function ghsaIdFromUrl(url) {
  const m = /\/advisories\/(GHSA-[a-z0-9-]+)/i.exec(url || '');
  return m ? m[1] : null;
}

async function runScan() {
  const { rows: [scan] } = await pool.query(
    `INSERT INTO security_scans (status) VALUES ('running') RETURNING id`
  );

  try {
    const audit = runNpmAudit();
    const kevMap = await fetchKevCveSet();
    const ghsaCveCache = new Map();

    const findings = [];
    for (const pkg of Object.values(audit.vulnerabilities || {})) {
      const fixAvailable = pkg.fixAvailable === true
        ? null
        : (pkg.fixAvailable?.version || null);

      for (const via of pkg.via) {
        // Bare strings are just "this came in via package X" pointers to
        // another entry in the same report -- the real advisory detail
        // (and this exact finding) is recorded once, under that other
        // package's own `via` array.
        if (typeof via !== 'object') continue;

        const ghsaId = ghsaIdFromUrl(via.url);
        const cveId  = ghsaId ? await lookupGhsaCve(ghsaId, ghsaCveCache) : null;
        const isKev  = cveId ? kevMap.has(cveId) : false;

        findings.push({
          package_name: pkg.name,
          severity: via.severity,
          title: via.title,
          ghsa_id: ghsaId,
          cve_id: cveId,
          url: via.url,
          is_kev: isKev,
          kev_due_date: isKev ? kevMap.get(cveId) : null,
          fix_available_version: fixAvailable,
        });
      }
    }

    for (const f of findings) {
      await pool.query(
        `INSERT INTO security_scan_findings
           (scan_id, package_name, severity, title, ghsa_id, cve_id, url, is_kev, kev_due_date, fix_available_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [scan.id, f.package_name, f.severity, f.title, f.ghsa_id, f.cve_id, f.url, f.is_kev, f.kev_due_date, f.fix_available_version]
      );
    }

    const summary = {
      total: findings.length,
      bySeverity: findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {}),
      kevCount: findings.filter(f => f.is_kev).length,
      npmAuditMetadata: audit.metadata || null,
    };

    await pool.query(
      `UPDATE security_scans SET status = 'completed', completed_at = NOW(), summary = $1 WHERE id = $2`,
      [JSON.stringify(summary), scan.id]
    );

    return { scanId: scan.id, summary };
  } catch (err) {
    await pool.query(
      `UPDATE security_scans SET status = 'failed', completed_at = NOW(), error = $1 WHERE id = $2`,
      [err.message, scan.id]
    );
    throw err;
  }
}

module.exports = { runScan };
