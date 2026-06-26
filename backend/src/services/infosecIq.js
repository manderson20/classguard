// Infosec IQ (by Infosec Institute) API integration.
//
// Official API spec: https://securityiq.infosecinstitute.com/api/v2
// Auth: Authorization: Bearer <api_key>  (apiKey in header)
// Pagination: ?limit=N&page=N  — meta.pageCount is total pages (max limit=100)
//
// Settings keys:
//   infoseciq_base_url — default: https://securityiq.infosecinstitute.com/api/v2
//   infoseciq_api_key  — generated in Infosec IQ app → Settings → API

const { pool } = require('../db');

const DEFAULT_BASE_URL = 'https://securityiq.infosecinstitute.com/api/v2';

const ENDPOINTS = {
  learners:            '/learners',
  campaigns:           '/campaigns',
  campaignRuns:        (id)       => `/campaigns/${id}/runs`,
  campaignRunLearners: (cid, rid) => `/campaigns/${cid}/runs/${rid}/learners`,
  campaignRunStats:    (cid, rid) => `/campaigns/${cid}/runs/${rid}/stats`,
};

async function getCredentials() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('infoseciq_base_url', 'infoseciq_api_key')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!cfg.infoseciq_api_key) throw new Error('Infosec IQ API key not configured');
  return {
    baseUrl: (cfg.infoseciq_base_url || DEFAULT_BASE_URL).replace(/\/$/, ''),
    apiKey:  cfg.infoseciq_api_key,
  };
}

async function apiFetch(path, { limit = 100, page = 1 } = {}) {
  const { baseUrl, apiKey } = await getCredentials();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${baseUrl}${path}${sep}limit=${limit}&page=${page}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Infosec IQ ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Paginate through all results.
// Response shape: { meta: { page, pageCount, count, limit, ... }, data: [...] }
async function fetchAll(path) {
  const first = await apiFetch(path, { limit: 100, page: 1 });

  // Some endpoints return a plain array
  if (Array.isArray(first)) return first;

  const items     = first.data ?? first.results ?? [];
  const meta      = first.meta || {};
  const lastPage  = meta.pageCount || meta.last_page || meta.total_pages || 1;

  if (lastPage <= 1) return items;

  const pages = await Promise.all(
    Array.from({ length: lastPage - 1 }, (_, i) =>
      apiFetch(path, { limit: 100, page: i + 2 })
        .then(r => (Array.isArray(r) ? r : (r.data ?? r.results ?? [])))
        .catch(() => [])
    )
  );
  return items.concat(...pages);
}

// ---------------------------------------------------------------------------
// Connection test — hits /learners?limit=1 and returns diagnostic info
// ---------------------------------------------------------------------------
async function testConnection() {
  const { baseUrl, apiKey } = await getCredentials();
  const url = `${baseUrl}${ENDPOINTS.learners}?limit=1&page=1`;
  let res, rawText;
  try {
    res     = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    rawText = await res.text();
  } catch (err) {
    return { ok: false, status: null, urlTested: url, error: err.message };
  }

  let body;
  try { body = JSON.parse(rawText); } catch (_) { body = {}; }

  return {
    ok:        res.ok,
    status:    res.status,
    urlTested: url,
    detail:    rawText.slice(0, 300),
    sample:    res.ok ? body : undefined,
  };
}

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------
function parseLearner(raw) {
  const stat = raw.learner_stat || {};
  const profile = raw.learner_profile || {};

  // Grade from stat (0–100 scale) or fallback fields
  const grade = parseFloat(stat.grade ?? raw.risk_score ?? 0) || 0;

  const enrolled  = parseInt(stat.module_enrolled_count  ?? raw.courses_assigned  ?? 0) || 0;
  const completed = parseInt(stat.module_completed_count ?? raw.courses_completed ?? 0) || 0;
  const compPct   = enrolled > 0 ? Math.round((completed / enrolled) * 1000) / 10 : 0;

  return {
    id:                      String(raw.id ?? ''),
    email:                   raw.email ?? null,
    first_name:              raw.first_name ?? null,
    last_name:               raw.last_name  ?? null,
    department:              profile.department ?? raw.department ?? null,
    risk_score:              grade,
    training_completion_pct: compPct,
    courses_assigned:        enrolled,
    courses_completed:       completed,
    phishing_susceptibility: parseInt(stat.phished_count ?? 0) || 0,
    last_activity_at:        stat.modified ?? raw.modified ?? null,
  };
}

function parseCampaign(raw, runStats = null) {
  // API has no status field — just a `running` boolean.
  // Use the campaign type + running flag for a meaningful status string.
  const status = raw.running ? 'active' : 'completed';

  // Aggregate learner stats from the most recent run if available
  const learners = runStats?.learners || {};
  const started   = parseInt(learners.started   ?? 0) || 0;
  const completed = parseInt(learners.completed ?? 0) || 0;
  const total     = started + completed + (parseInt(learners.failed ?? 0) || 0);

  return {
    id:               String(raw.id ?? ''),
    name:             raw.name ?? 'Campaign',
    type:             raw.type ?? null,     // 'awareness' | 'phish'
    status,
    start_date:       raw.start_date ?? null,
    end_date:         raw.end_date   ?? null,
    recipients_total: total,
    emails_sent:      total,
    opens:            0,   // only available via timeline events (future)
    clicks:           0,
    reports:          0,
    click_rate:       0,
    report_rate:      0,
    completion_rate:  total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
  };
}

// ---------------------------------------------------------------------------
// Sync learners
// ---------------------------------------------------------------------------
async function syncLearners() {
  const raw = await fetchAll(ENDPOINTS.learners);
  let upserted = 0;

  for (const r of raw) {
    const l = parseLearner(r);
    if (!l.id) continue;

    await pool.query(
      `INSERT INTO infoseciq_learners
         (id, email, first_name, last_name, department, risk_score, training_completion_pct,
          courses_assigned, courses_completed, phishing_susceptibility, last_activity_at,
          raw_data, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
         department = EXCLUDED.department, risk_score = EXCLUDED.risk_score,
         training_completion_pct = EXCLUDED.training_completion_pct,
         courses_assigned = EXCLUDED.courses_assigned, courses_completed = EXCLUDED.courses_completed,
         phishing_susceptibility = EXCLUDED.phishing_susceptibility,
         last_activity_at = EXCLUDED.last_activity_at, raw_data = EXCLUDED.raw_data,
         last_synced_at = NOW()`,
      [l.id, l.email, l.first_name, l.last_name, l.department, l.risk_score,
       l.training_completion_pct, l.courses_assigned, l.courses_completed,
       l.phishing_susceptibility, l.last_activity_at, JSON.stringify(r)]
    );
    upserted++;
  }

  return { learners: upserted };
}

// ---------------------------------------------------------------------------
// Sync campaigns — lists all campaigns then fetches runs + run stats
// ---------------------------------------------------------------------------
async function syncCampaigns() {
  const raw = await fetchAll(ENDPOINTS.campaigns);
  let upserted = 0, resultRows = 0;

  for (const r of raw) {
    if (!r.id) continue;

    // Fetch campaign runs to get completion stats
    let runStats = null;
    try {
      const runs = await apiFetch(ENDPOINTS.campaignRuns(r.id), { limit: 10, page: 1 });
      const runList = Array.isArray(runs) ? runs : (runs.data ?? []);

      // Use the most recent run (highest run_number) for stats
      const latestRun = runList.sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0))[0];
      if (latestRun) {
        // AwareEd campaigns expose run stats; PhishSim returns 502 for this endpoint
        const statsRes = await apiFetch(ENDPOINTS.campaignRunStats(r.id, latestRun.id), { limit: 1, page: 1 })
          .catch(() => null);
        if (statsRes) runStats = Array.isArray(statsRes) ? statsRes[0] : statsRes;

        // Sync per-learner run data (both campaign types)
        try {
          const learnerPage = await apiFetch(ENDPOINTS.campaignRunLearners(r.id, latestRun.id), { limit: 100, page: 1 });
          const learners = Array.isArray(learnerPage) ? learnerPage : (learnerPage.data ?? []);
          for (const rl of learners) {
            if (!rl.id) continue;
            await pool.query(
              `INSERT INTO infoseciq_campaign_results
                 (campaign_id, learner_id, email, first_name, last_name, department,
                  sent_at, opened_at, clicked_at, reported_at, raw_data)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (campaign_id, email) DO UPDATE SET
                 learner_id = EXCLUDED.learner_id, raw_data = EXCLUDED.raw_data`,
              [String(r.id), String(rl.id), rl.email ?? null, rl.first_name ?? null,
               rl.last_name ?? null, rl.department ?? null,
               null, null, null, null, JSON.stringify(rl)]
            ).catch(() => {});
            resultRows++;
          }
        } catch (_) {}
      }
    } catch (_) {}

    const c = parseCampaign(r, runStats);

    await pool.query(
      `INSERT INTO infoseciq_campaigns
         (id, name, status, start_date, end_date, recipients_total, emails_sent,
          opens, clicks, reports, click_rate, report_rate, raw_data, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status,
         start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
         recipients_total = EXCLUDED.recipients_total, emails_sent = EXCLUDED.emails_sent,
         opens = EXCLUDED.opens, clicks = EXCLUDED.clicks, reports = EXCLUDED.reports,
         click_rate = EXCLUDED.click_rate, report_rate = EXCLUDED.report_rate,
         raw_data = EXCLUDED.raw_data, last_synced_at = NOW()`,
      [c.id, c.name, c.status, c.start_date, c.end_date, c.recipients_total, c.emails_sent,
       c.opens, c.clicks, c.reports, c.click_rate, c.report_rate, JSON.stringify(r)]
    );
    upserted++;
  }

  return { campaigns: upserted, campaignResults: resultRows };
}

async function syncAll() {
  const [l, c] = await Promise.all([syncLearners(), syncCampaigns()]);
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('last_infoseciq_sync', NOW()::text, NOW())
     ON CONFLICT (key) DO UPDATE SET value = NOW()::text, updated_at = NOW()`
  );
  return { ...l, ...c };
}

module.exports = { testConnection, syncLearners, syncCampaigns, syncAll };
