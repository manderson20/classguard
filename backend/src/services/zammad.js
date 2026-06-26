const axios = require('axios');
const { pool } = require('../db');

async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('zammad_url','zammad_token')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    url:   process.env.ZAMMAD_URL   || cfg.zammad_url   || null,
    token: process.env.ZAMMAD_TOKEN || cfg.zammad_token || null,
  };
}

function client(url, token) {
  return axios.create({
    baseURL: url.replace(/\/$/, '') + '/api/v1',
    headers: { Authorization: `Token token=${token}`, 'Content-Type': 'application/json' },
    timeout: 10_000,
  });
}

async function getClient() {
  const cfg = await getConfig();
  if (!cfg.url || !cfg.token) {
    throw new Error('Zammad is not configured. Add the URL and API token in Integrations → Zammad.');
  }
  return client(cfg.url, cfg.token);
}

// Verify credentials and return the authenticated user's info
async function testConnection() {
  const cfg = await getConfig();
  if (!cfg.url || !cfg.token) throw new Error('URL and API token are required');
  const http = client(cfg.url, cfg.token);
  const res = await http.get('/users/me', { params: { expand: true } });
  const u = res.data;
  return {
    login: u.login,
    name:  [u.firstname, u.lastname].filter(Boolean).join(' '),
    email: u.email,
  };
}

// ---------------------------------------------------------------------------
// Routing rules — maps ClassGuard event types to Zammad group + priority
// ---------------------------------------------------------------------------
async function getRoutingRules() {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'zammad_routing_rules'`);
  try { return JSON.parse(rows[0]?.value || '{}'); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
async function listTickets({ page = 1, perPage = 50 } = {}) {
  const http = await getClient();
  const res = await http.get('/tickets', {
    params: { expand: true, page, per_page: perPage, sort_by: 'updated_at', order_by: 'desc' },
  });
  return Array.isArray(res.data) ? res.data : [];
}

async function getTicket(id) {
  const http = await getClient();
  const res  = await http.get(`/tickets/${id}`, { params: { expand: true } });
  return res.data;
}

async function getGroups() {
  const http = await getClient();
  const res  = await http.get('/groups', { params: { per_page: 200 } });
  return Array.isArray(res.data) ? res.data.filter(g => g.active !== false) : [];
}

async function createTicket({ title, body, customerEmail, group = 'Users', priority = '2 normal', tags = [] }) {
  const http = await getClient();
  const res  = await http.post('/tickets', {
    title,
    group,
    customer: customerEmail || 'classguard-system@classguard.local',
    article: { subject: title, body, type: 'note', internal: false },
    priority,
    tags,
  });
  return res.data;
}

async function addTicketNote(ticketId, body, internal = true) {
  const http = await getClient();
  const res  = await http.post('/ticket_articles', {
    ticket_id: ticketId,
    body,
    type: 'note',
    internal,
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// Auto-ticket creation from ClassGuard events
// Checks routing rules — only creates if auto_create is enabled for the type
// ---------------------------------------------------------------------------
async function createTicketForEvent(eventType, { title, body, customerEmail = '' } = {}) {
  const rules = await getRoutingRules();
  const rule  = rules[eventType];
  if (!rule?.auto_create || !rule?.group) return null;

  try {
    const ticket = await createTicket({
      title,
      body,
      customerEmail: customerEmail || 'classguard-system@classguard.local',
      group:    rule.group,
      priority: rule.priority || '2 normal',
      tags:     ['classguard', eventType.replace(/_/g, '-')],
    });
    console.log(`[zammad] Auto-created ticket #${ticket.number} for event=${eventType}`);
    return ticket;
  } catch (err) {
    console.error(`[zammad] Failed to create ticket for event=${eventType}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent statistics — aggregate from ticket list + time accounting
// ---------------------------------------------------------------------------
async function getAgentStats() {
  const http = await getClient();

  // Fetch up to 500 tickets with expanded owner/time fields
  const res = await http.get('/tickets', {
    params: { expand: true, page: 1, per_page: 500, sort_by: 'updated_at', order_by: 'desc' },
  });
  const tickets = Array.isArray(res.data) ? res.data : [];

  // Try to get time accounting entries (requires time accounting feature in Zammad)
  let timeEntries = [];
  try {
    const timeRes = await http.get('/time_accountings', { params: { per_page: 1000 } });
    timeEntries = Array.isArray(timeRes.data) ? timeRes.data : [];
  } catch { /* time accounting may not be enabled */ }

  // Aggregate per-agent from ticket ownership
  const agentMap = {};
  for (const t of tickets) {
    const owner = t.owner || 'Unassigned';
    if (!agentMap[owner]) {
      agentMap[owner] = { name: owner, open: 0, pending: 0, closed: 0, total: 0, minutes: 0 };
    }
    agentMap[owner].total++;
    const state = (t.state || '').toLowerCase();
    if (state === 'closed' || state === 'merged') agentMap[owner].closed++;
    else if (state.startsWith('pending'))          agentMap[owner].pending++;
    else                                           agentMap[owner].open++;
    // Some Zammad setups put time on the ticket directly
    if (t.time_unit) agentMap[owner].minutes += parseFloat(t.time_unit) || 0;
  }

  // Also aggregate time accounting entries by created_by (agent who logged time)
  // time_accounting entries have: time_unit (minutes), ticket_id, created_by (login/name)
  for (const entry of timeEntries) {
    const agent = entry.created_by || entry.created_by_id;
    if (!agent || typeof agent !== 'string') continue;
    if (!agentMap[agent]) agentMap[agent] = { name: agent, open: 0, pending: 0, closed: 0, total: 0, minutes: 0 };
    agentMap[agent].minutes += parseFloat(entry.time_unit) || 0;
  }

  return Object.values(agentMap)
    .filter(a => a.name !== 'Unassigned' || a.total > 0)
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// Sync into local cache
// ---------------------------------------------------------------------------
async function syncTickets() {
  const http = await getClient();
  const res = await http.get('/tickets', {
    params: { expand: true, page: 1, per_page: 200, sort_by: 'updated_at', order_by: 'desc' },
  });
  const tickets = Array.isArray(res.data) ? res.data : [];

  for (const t of tickets) {
    await pool.query(
      `INSERT INTO zammad_tickets
         (zammad_id, number, title, state, priority, customer_email, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (zammad_id) DO UPDATE SET
         title          = EXCLUDED.title,
         state          = EXCLUDED.state,
         priority       = EXCLUDED.priority,
         customer_email = EXCLUDED.customer_email,
         synced_at      = NOW()`,
      [t.id, t.number, t.title, t.state, t.priority, t.customer || null]
    ).catch(() => {});
  }

  return tickets.length;
}

module.exports = {
  getConfig, testConnection, getRoutingRules,
  getGroups, listTickets, getTicket,
  createTicket, createTicketForEvent,
  addTicketNote, getAgentStats, syncTickets,
};
