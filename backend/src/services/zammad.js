const axios = require('axios');
const { pool } = require('../db');

function keaClient() {
  const url   = process.env.ZAMMAD_URL;
  const token = process.env.ZAMMAD_TOKEN;
  if (!url || !token) throw new Error('ZAMMAD_URL and ZAMMAD_TOKEN must be configured in Settings');
  return axios.create({
    baseURL: url.replace(/\/$/, '') + '/api/v1',
    headers: { Authorization: `Token token=${token}`, 'Content-Type': 'application/json' },
    timeout: 10_000,
  });
}

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
    throw new Error('Zammad is not configured. Add ZAMMAD_URL and ZAMMAD_TOKEN in Settings → Integrations.');
  }
  return client(cfg.url, cfg.token);
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
async function listTickets({ page = 1, perPage = 25, state } = {}) {
  const http  = await getClient();
  const query = state ? `state.name:${state}` : '';
  const res   = await http.get('/tickets/search', {
    params: { query: query || 'id:*', page, per_page: perPage },
  });
  return res.data;
}

async function getTicket(id) {
  const http = await getClient();
  const res  = await http.get(`/tickets/${id}`);
  return res.data;
}

async function createTicket({ title, body, customerEmail, group = 'Users', priority = '2 normal', tags = [] }) {
  const http = await getClient();
  const res  = await http.post('/tickets', {
    title,
    group,
    customer: customerEmail,
    article: {
      subject: title,
      body,
      type: 'note',
      internal: false,
    },
    priority,
    tags,
  });
  return res.data;
}

async function addTicketNote(ticketId, body, internal = true) {
  const http = await getClient();
  const res  = await http.post(`/ticket_articles`, {
    ticket_id: ticketId,
    body,
    type: 'note',
    internal,
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// Sync recent tickets into the local cache
// ---------------------------------------------------------------------------
async function syncTickets() {
  const http = await getClient();
  const res  = await http.get('/tickets/search', {
    params: { query: 'id:*', page: 1, per_page: 100, sort_by: 'updated_at', order_by: 'desc' },
  });

  const tickets = Array.isArray(res.data) ? res.data : (res.data?.assets?.Ticket ? Object.values(res.data.assets.Ticket) : []);

  for (const t of tickets) {
    await pool.query(
      `INSERT INTO zammad_tickets
         (zammad_id, number, title, state, priority, customer_email, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (zammad_id) DO UPDATE SET
         title = EXCLUDED.title, state = EXCLUDED.state,
         updated_at = EXCLUDED.updated_at, synced_at = NOW()`,
      [t.id, t.number, t.title, t.state, t.priority, t.customer]
    ).catch(() => {});
  }

  return tickets.length;
}

module.exports = { getConfig, listTickets, getTicket, createTicket, addTicketNote, syncTickets };
