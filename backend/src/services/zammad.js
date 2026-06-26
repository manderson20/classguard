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
    throw new Error('Zammad is not configured. Add the URL and API token in Settings → Integrations.');
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
    role:  u.role_ids?.length ? 'agent/admin' : 'user',
  };
}

// ---------------------------------------------------------------------------
// Tickets — uses expand=true so state/priority come back as strings
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
    customer: customerEmail,
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
// Sync into local cache
// ---------------------------------------------------------------------------
async function syncTickets() {
  const http = await getClient();
  // Fetch up to 200 most-recently-updated tickets with expanded fields
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

module.exports = { getConfig, testConnection, getGroups, listTickets, getTicket, createTicket, addTicketNote, syncTickets };
