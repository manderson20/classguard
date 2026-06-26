// Infosec IQ (by Infosec Institute) API integration.
//
// API base URL and key are stored in the settings table under keys:
//   infoseciq_base_url  — e.g. https://api.infosecinstitute.com/iqv2
//   infoseciq_api_key   — the API key from your Infosec IQ account settings
//
// Auth: Bearer token sent as  Authorization: Bearer <api_key>
//
// Endpoint paths below match the standard Infosec IQ v2 reporting API.
// If your contract exposes different paths, update the constants below.

const { pool } = require('../db');

const ENDPOINTS = {
  learners:          '/users',
  campaigns:         '/phishing/campaigns',
  campaignResults:   (id) => `/phishing/campaigns/${id}/recipients`,
};

async function getCredentials() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('infoseciq_base_url', 'infoseciq_api_key')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!cfg.infoseciq_api_key) throw new Error('Infosec IQ API key not configured');
  return {
    baseUrl: (cfg.infoseciq_base_url || 'https://api.infosecinstitute.com/iqv2').replace(/\/$/, ''),
    apiKey:  cfg.infoseciq_api_key,
  };
}

async function apiFetch(path, { pageSize = 100, page = 1 } = {}) {
  const { baseUrl, apiKey } = await getCredentials();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${baseUrl}${path}${sep}page_size=${pageSize}&page=${page}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Infosec IQ API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Paginate through all results using typical Infosec IQ pagination shape:
// { data: [...], meta: { total: N, per_page: N, current_page: N, last_page: N } }
// Falls back gracefully if response is a plain array.
async function fetchAll(path) {
  const first = await apiFetch(path, { pageSize: 200, page: 1 });
  if (Array.isArray(first)) return first;

  const items = first.data ?? first.results ?? first.users ?? first.campaigns ?? [];
  const meta  = first.meta || first.pagination || {};
  const lastPage = meta.last_page || meta.total_pages || 1;

  if (lastPage <= 1) return items;

  const pages = await Promise.all(
    Array.from({ length: lastPage - 1 }, (_, i) =>
      apiFetch(path, { pageSize: 200, page: i + 2 })
        .then(r => r.data ?? r.results ?? r.users ?? r.campaigns ?? [])
        .catch(() => [])
    )
  );
  return items.concat(...pages);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function testConnection() {
  const { baseUrl, apiKey } = await getCredentials();
  const url = `${baseUrl}${ENDPOINTS.learners}?page_size=1&page=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, sample: body };
}

function parseLearner(raw) {
  return {
    id:                      String(raw.id ?? raw.user_id ?? raw.learner_id ?? ''),
    email:                   raw.email ?? raw.email_address ?? null,
    first_name:              raw.first_name ?? raw.firstname ?? null,
    last_name:               raw.last_name ?? raw.lastname ?? null,
    department:              raw.department ?? raw.group ?? null,
    risk_score:              parseFloat(raw.risk_score ?? raw.risk ?? 0) || 0,
    training_completion_pct: parseFloat(raw.completion_percentage ?? raw.completion_pct ?? raw.progress ?? 0) || 0,
    courses_assigned:        parseInt(raw.courses_assigned ?? raw.assigned ?? 0) || 0,
    courses_completed:       parseInt(raw.courses_completed ?? raw.completed ?? 0) || 0,
    phishing_susceptibility: parseFloat(raw.susceptibility ?? raw.click_rate ?? 0) || 0,
    last_activity_at:        raw.last_activity ?? raw.last_login ?? null,
  };
}

function parseCampaign(raw) {
  const total     = parseInt(raw.recipients ?? raw.total_recipients ?? raw.recipients_count ?? 0) || 0;
  const clicks    = parseInt(raw.clicks ?? raw.click_count ?? 0) || 0;
  const opens     = parseInt(raw.opens  ?? raw.open_count  ?? 0) || 0;
  const reports   = parseInt(raw.reports ?? raw.report_count ?? 0) || 0;
  const sent      = parseInt(raw.emails_sent ?? raw.sent ?? total) || 0;
  return {
    id:               String(raw.id ?? raw.campaign_id ?? ''),
    name:             raw.name ?? raw.title ?? raw.campaign_name ?? 'Campaign',
    status:           raw.status ?? 'unknown',
    start_date:       raw.start_date ?? raw.created_at ?? null,
    end_date:         raw.end_date   ?? raw.completed_at ?? null,
    recipients_total: total,
    emails_sent:      sent,
    opens,
    clicks,
    reports,
    click_rate:       sent > 0 ? Math.round((clicks / sent) * 1000) / 10 : 0,
    report_rate:      sent > 0 ? Math.round((reports / sent) * 1000) / 10 : 0,
  };
}

function parseCampaignResult(raw, campaignId) {
  return {
    campaign_id:  campaignId,
    learner_id:   String(raw.user_id ?? raw.learner_id ?? raw.id ?? ''),
    email:        raw.email ?? raw.email_address ?? null,
    first_name:   raw.first_name ?? raw.firstname ?? null,
    last_name:    raw.last_name  ?? raw.lastname  ?? null,
    department:   raw.department ?? raw.group     ?? null,
    sent_at:      raw.sent_at      ?? raw.sent     ?? null,
    opened_at:    raw.opened_at    ?? raw.opened   ?? null,
    clicked_at:   raw.clicked_at   ?? raw.clicked  ?? null,
    reported_at:  raw.reported_at  ?? raw.reported ?? null,
  };
}

async function syncLearners() {
  const raw = await fetchAll(ENDPOINTS.learners);
  let upserted = 0;
  for (const r of raw) {
    const l = parseLearner(r);
    if (!l.id) continue;
    await pool.query(
      `INSERT INTO infoseciq_learners
         (id, email, first_name, last_name, department, risk_score, training_completion_pct,
          courses_assigned, courses_completed, phishing_susceptibility, last_activity_at, raw_data, last_synced_at)
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

async function syncCampaigns() {
  const raw = await fetchAll(ENDPOINTS.campaigns);
  let upserted = 0, resultRows = 0;
  for (const r of raw) {
    const c = parseCampaign(r);
    if (!c.id) continue;
    await pool.query(
      `INSERT INTO infoseciq_campaigns
         (id, name, status, start_date, end_date, recipients_total, emails_sent,
          opens, clicks, reports, click_rate, report_rate, raw_data, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status, start_date = EXCLUDED.start_date,
         end_date = EXCLUDED.end_date, recipients_total = EXCLUDED.recipients_total,
         emails_sent = EXCLUDED.emails_sent, opens = EXCLUDED.opens, clicks = EXCLUDED.clicks,
         reports = EXCLUDED.reports, click_rate = EXCLUDED.click_rate, report_rate = EXCLUDED.report_rate,
         raw_data = EXCLUDED.raw_data, last_synced_at = NOW()`,
      [c.id, c.name, c.status, c.start_date, c.end_date, c.recipients_total, c.emails_sent,
       c.opens, c.clicks, c.reports, c.click_rate, c.report_rate, JSON.stringify(r)]
    );
    upserted++;

    // Fetch per-recipient results for completed/active campaigns
    if (['completed', 'active', 'running'].includes(c.status?.toLowerCase())) {
      try {
        const recipRaw = await fetchAll(ENDPOINTS.campaignResults(c.id));
        for (const rr of recipRaw) {
          const res = parseCampaignResult(rr, c.id);
          if (!res.email) continue;
          await pool.query(
            `INSERT INTO infoseciq_campaign_results
               (campaign_id, learner_id, email, first_name, last_name, department,
                sent_at, opened_at, clicked_at, reported_at, raw_data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (campaign_id, email) DO UPDATE SET
               learner_id = EXCLUDED.learner_id, first_name = EXCLUDED.first_name,
               last_name = EXCLUDED.last_name, department = EXCLUDED.department,
               sent_at = EXCLUDED.sent_at, opened_at = EXCLUDED.opened_at,
               clicked_at = EXCLUDED.clicked_at, reported_at = EXCLUDED.reported_at,
               raw_data = EXCLUDED.raw_data`,
            [res.campaign_id, res.learner_id, res.email, res.first_name, res.last_name,
             res.department, res.sent_at, res.opened_at, res.clicked_at, res.reported_at,
             JSON.stringify(rr)]
          );
          resultRows++;
        }
      } catch (err) {
        console.warn(`[infoseciq] campaign ${c.id} results: ${err.message}`);
      }
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
