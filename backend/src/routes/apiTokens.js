// Generic registry for shared-secret tokens that gate read-only external
// API integrations (the X-ClassGuard-Token pattern — see routes/lookup.js
// for the first consumer, PrintOps' IP->MAC lookup). Lives on the
// Integrations page as a list rather than one bespoke settings field per
// integration, so adding the next external API is a new row here, not new
// UI. Token values are always server-generated (crypto.randomBytes) —
// never hand-typed — so rotating a suspected-compromised token is always
// a single click.

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { pool }           = require('../db');
const { authenticate }   = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const auth = [authenticate, requirePermission('integrations')];

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// GET /api/v1/api-tokens
router.get('/', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, label, description, token, is_active, last_used_at, created_at, updated_at
     FROM api_tokens ORDER BY created_at ASC`
  );
  res.json(rows);
});

// POST /api/v1/api-tokens  body: { name, label, description }
// name is a stable slug (e.g. 'printops_lookup') that a consumer route
// checks against — changing it later would break that route's lookup, so
// it's set once at creation and not editable through PUT below.
router.post('/', ...auth, async (req, res) => {
  const { name, label, description } = req.body;
  if (!name || !label) return res.status(400).json({ error: 'name and label are required' });
  if (!/^[a-z0-9_]+$/.test(name)) {
    return res.status(400).json({ error: 'name must be lowercase letters, numbers, and underscores only' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO api_tokens (name, label, description, token, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, name, label, description, token, is_active, last_used_at, created_at, updated_at`,
      [name, label, description || null, generateToken()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A token named '${name}' already exists` });
    console.error('[api-tokens] POST error:', err);
    res.status(500).json({ error: 'Failed to create token' });
  }
});

// PUT /api/v1/api-tokens/:id  body: { label?, description?, is_active? }
// Flips is_active independently of the token value, so an admin can kill
// a suspected-compromised token immediately and decide on a replacement
// (via regenerate below) separately.
router.put('/:id', ...auth, async (req, res) => {
  const { label, description, is_active } = req.body;
  const { rows } = await pool.query(
    `UPDATE api_tokens SET
       label       = COALESCE($2, label),
       description = COALESCE($3, description),
       is_active   = COALESCE($4, is_active),
       updated_at  = NOW()
     WHERE id = $1
     RETURNING id, name, label, description, token, is_active, last_used_at, created_at, updated_at`,
    [req.params.id, label ?? null, description ?? null, is_active ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: 'Token not found' });
  res.json(rows[0]);
});

// POST /api/v1/api-tokens/:id/regenerate — the one-click rotate: replaces
// the token value with a fresh random one and (re)activates it.
router.post('/:id/regenerate', ...auth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_tokens SET token = $2, is_active = true, updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, label, description, token, is_active, last_used_at, created_at, updated_at`,
    [req.params.id, generateToken()]
  );
  if (!rows.length) return res.status(404).json({ error: 'Token not found' });
  res.json(rows[0]);
});

// DELETE /api/v1/api-tokens/:id
router.delete('/:id', ...auth, async (req, res) => {
  await pool.query(`DELETE FROM api_tokens WHERE id = $1`, [req.params.id]);
  res.json({ deleted: true });
});

module.exports = router;
