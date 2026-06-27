// Infosec IQ (by Infosec Institute) API integration.
//
// Official API: https://securityiq.infosecinstitute.com/api/v2
// Auth:         Authorization: Bearer <api_key>
// Pagination:   ?limit=N&page=N  (max limit=100); meta.pageCount = total pages
//
// Settings keys:
//   infoseciq_base_url  — default: https://securityiq.infosecinstitute.com/api/v2
//   infoseciq_api_key   — generated in Infosec IQ app → Settings → API

const { pool } = require('../db');

const DEFAULT_BASE_URL = 'https://securityiq.infosecinstitute.com/api/v2';

const ENDPOINTS = {
  learners:            '/learners',
  learner:             (id)       => `/learners/${id}`,
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
    throw new Error(`Infosec IQ ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchAll(path) {
  const first    = await apiFetch(path, { limit: 100, page: 1 });
  if (Array.isArray(first)) return first;

  const items    = first.data ?? first.results ?? [];
  const meta     = first.meta || {};
  const lastPage = meta.pageCount || meta.last_page || meta.total_pages || 1;
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

// Run `fn` over every item in `arr` with at most `concurrency` in-flight.
async function pMap(arr, fn, concurrency = 10) {
  const results = [];
  for (let i = 0; i < arr.length; i += concurrency) {
    const batch = await Promise.all(arr.slice(i, i + concurrency).map(fn));
    results.push(...batch);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Connection test
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
  return { ok: res.ok, status: res.status, urlTested: url, detail: rawText.slice(0, 300), sample: res.ok ? body : undefined };
}

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------
function parseLearner(raw) {
  const stat    = raw.learner_stat    || {};
  const profile = raw.learner_profile || {};

  const enrolled   = parseInt(stat.module_enrolled_count  ?? raw.courses_assigned  ?? 0) || 0;
  const completed  = parseInt(stat.module_completed_count ?? raw.courses_completed ?? 0) || 0;
  const compPct    = enrolled > 0 ? Math.round((completed / enrolled) * 1000) / 10 : 0;

  return {
    id:                      String(raw.id ?? ''),
    email:                   raw.email ?? null,
    first_name:              raw.first_name ?? null,
    last_name:               raw.last_name  ?? null,
    department:              profile.department ?? raw.department ?? null,
    // Grade card fields from learner_stat (only present on /learners/{id} response)
    letter_grade:            stat.letter_grade    ?? null,
    grade_score:             parseFloat(stat.grade ?? 0) || 0,
    phished_count:           parseInt(stat.phished_count        ?? 0) || 0,
    data_entry_count:        parseInt(stat.data_entry_count     ?? 0) || 0,
    training_time_minutes:   parseInt(stat.total_time_trained   ?? 0) || 0,
    modules_enrolled:        enrolled,
    modules_completed:       completed,
    assessments_passed:      parseInt(stat.assessment_passed_count    ?? 0) || 0,
    assessments_failed:      Math.max(0, (parseInt(stat.assessment_completed_count ?? 0) || 0) - (parseInt(stat.assessment_passed_count ?? 0) || 0)),
    // Full PhishSim / training stats for exit ticket
    replied_count:                   parseInt(stat.replied_count                    ?? 0) || 0,
    matched_count:                   parseInt(stat.matched_count                    ?? 0) || 0,
    attachment_count:                parseInt(stat.attachment_count                 ?? 0) || 0,
    teachable_count:                 parseInt(stat.teachable_count                  ?? 0) || 0,
    training_started_count:          parseInt(stat.training_started_count           ?? 0) || 0,
    training_completed_count:        parseInt(stat.training_completed_count         ?? 0) || 0,
    plugin_email_report_count:       parseInt(stat.plugin_email_report_count        ?? 0) || 0,
    plugin_simulation_report_count:  parseInt(stat.plugin_simulation_report_count   ?? 0) || 0,
    // Legacy columns (kept for backwards compat)
    risk_score:              parseFloat(stat.grade ?? 0) || 0,
    training_completion_pct: compPct,
    courses_assigned:        enrolled,
    courses_completed:       completed,
    phishing_susceptibility: parseInt(stat.phished_count ?? 0) || 0,
    last_activity_at:        stat.modified ?? raw.modified ?? null,
  };
}

function parseCampaign(raw, runStats = null) {
  const learners = runStats?.learners || {};
  const total    = (parseInt(learners.started   ?? 0) || 0)
                 + (parseInt(learners.completed ?? 0) || 0)
                 + (parseInt(learners.failed    ?? 0) || 0);
  return {
    id:               String(raw.id ?? ''),
    name:             raw.name  ?? 'Campaign',
    campaign_type:    raw.type  ?? null,
    status:           raw.running ? 'active' : 'completed',
    start_date:       raw.start_date ?? null,
    end_date:         raw.end_date   ?? null,
    recipients_total: total || 0,
    emails_sent:      total || 0,
    opens: 0, clicks: 0, reports: 0, click_rate: 0, report_rate: 0,
  };
}

// ---------------------------------------------------------------------------
// Sync learners — list first, then fetch individual stat pages in parallel.
// The /learners list endpoint returns only id/email/name/modified.
// The /learners/{id} endpoint returns learner_stat with grades, phish counts, etc.
// ---------------------------------------------------------------------------
async function syncLearners() {
  const raw = await fetchAll(ENDPOINTS.learners);

  // Fetch full stat records in parallel batches of 15
  const detailed = await pMap(raw, async (r) => {
    if (!r.id) return r;
    try {
      const full = await apiFetch(ENDPOINTS.learner(r.id));
      // /learners/{id} wraps in a top-level object with learner_stat
      return full.id ? full : { ...r, ...full };
    } catch (_) {
      return r; // fall back to list data if individual fetch fails
    }
  }, 15);

  let upserted = 0;
  for (const r of detailed) {
    const l = parseLearner(r);
    if (!l.id) continue;
    await pool.query(
      `INSERT INTO infoseciq_learners
         (id, email, first_name, last_name, department,
          letter_grade, grade_score, phished_count, data_entry_count,
          training_time_minutes, modules_enrolled, modules_completed,
          assessments_passed, assessments_failed,
          replied_count, matched_count, attachment_count, teachable_count,
          training_started_count, training_completed_count,
          plugin_email_report_count, plugin_simulation_report_count,
          risk_score, training_completion_pct, courses_assigned, courses_completed,
          phishing_susceptibility, last_activity_at, raw_data, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,NOW())
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email, first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name, department = EXCLUDED.department,
         letter_grade = EXCLUDED.letter_grade, grade_score = EXCLUDED.grade_score,
         phished_count = EXCLUDED.phished_count, data_entry_count = EXCLUDED.data_entry_count,
         training_time_minutes = EXCLUDED.training_time_minutes,
         modules_enrolled = EXCLUDED.modules_enrolled, modules_completed = EXCLUDED.modules_completed,
         assessments_passed = EXCLUDED.assessments_passed, assessments_failed = EXCLUDED.assessments_failed,
         replied_count = EXCLUDED.replied_count, matched_count = EXCLUDED.matched_count,
         attachment_count = EXCLUDED.attachment_count, teachable_count = EXCLUDED.teachable_count,
         training_started_count = EXCLUDED.training_started_count,
         training_completed_count = EXCLUDED.training_completed_count,
         plugin_email_report_count = EXCLUDED.plugin_email_report_count,
         plugin_simulation_report_count = EXCLUDED.plugin_simulation_report_count,
         risk_score = EXCLUDED.risk_score, training_completion_pct = EXCLUDED.training_completion_pct,
         courses_assigned = EXCLUDED.courses_assigned, courses_completed = EXCLUDED.courses_completed,
         phishing_susceptibility = EXCLUDED.phishing_susceptibility,
         last_activity_at = EXCLUDED.last_activity_at, raw_data = EXCLUDED.raw_data,
         last_synced_at = NOW()`,
      [l.id, l.email, l.first_name, l.last_name, l.department,
       l.letter_grade, l.grade_score, l.phished_count, l.data_entry_count,
       l.training_time_minutes, l.modules_enrolled, l.modules_completed,
       l.assessments_passed, l.assessments_failed,
       l.replied_count, l.matched_count, l.attachment_count, l.teachable_count,
       l.training_started_count, l.training_completed_count,
       l.plugin_email_report_count, l.plugin_simulation_report_count,
       l.risk_score, l.training_completion_pct, l.courses_assigned, l.courses_completed,
       l.phishing_susceptibility, l.last_activity_at, JSON.stringify(r)]
    );
    upserted++;
  }
  return { learners: upserted };
}

// ---------------------------------------------------------------------------
// Sync campaigns — insert campaign FIRST, then results (fixes FK ordering bug).
// ---------------------------------------------------------------------------
async function syncCampaigns() {
  const raw = await fetchAll(ENDPOINTS.campaigns);
  let upserted = 0, resultRows = 0;

  for (const r of raw) {
    if (!r.id) continue;

    // Fetch runs to get completion stats
    let runStats = null, latestRun = null;
    try {
      const runs = await apiFetch(ENDPOINTS.campaignRuns(r.id), { limit: 10, page: 1 });
      const runList = Array.isArray(runs) ? runs : (runs.data ?? []);
      latestRun = runList.sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0))[0];
      if (latestRun) {
        // AwareEd only — PhishSim returns 502 here, which we catch and ignore
        const statsRes = await apiFetch(ENDPOINTS.campaignRunStats(r.id, latestRun.id), { limit: 1, page: 1 })
          .catch(() => null);
        if (statsRes) runStats = Array.isArray(statsRes) ? statsRes[0] : statsRes;
      }
    } catch (_) {}

    const c = parseCampaign(r, runStats);

    // Insert campaign BEFORE results so the FK constraint is satisfied
    await pool.query(
      `INSERT INTO infoseciq_campaigns
         (id, name, status, campaign_type, start_date, end_date,
          recipients_total, emails_sent, opens, clicks, reports,
          click_rate, report_rate, raw_data, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status,
         campaign_type = EXCLUDED.campaign_type,
         start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
         recipients_total = EXCLUDED.recipients_total, emails_sent = EXCLUDED.emails_sent,
         opens = EXCLUDED.opens, clicks = EXCLUDED.clicks, reports = EXCLUDED.reports,
         click_rate = EXCLUDED.click_rate, report_rate = EXCLUDED.report_rate,
         raw_data = EXCLUDED.raw_data, last_synced_at = NOW()`,
      [c.id, c.name, c.status, c.campaign_type, c.start_date, c.end_date,
       c.recipients_total, c.emails_sent, 0, 0, 0, 0, 0, JSON.stringify(r)]
    );
    upserted++;

    // Sync per-learner run data using learner_id (not email) as conflict key
    if (latestRun) {
      try {
        const learnerPages = await fetchAll(ENDPOINTS.campaignRunLearners(r.id, latestRun.id));
        for (const rl of learnerPages) {
          if (!rl.id) continue;
          await pool.query(
            `INSERT INTO infoseciq_campaign_results
               (campaign_id, learner_id, completion_status, completed_on, raw_data)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (campaign_id, learner_id) DO UPDATE SET
               completion_status = EXCLUDED.completion_status,
               completed_on = EXCLUDED.completed_on,
               raw_data = EXCLUDED.raw_data`,
            [String(r.id), String(rl.id), rl.status ?? null,
             rl.completed_on ?? null, JSON.stringify(rl)]
          );
          resultRows++;
        }
      } catch (_) {}
    }
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
