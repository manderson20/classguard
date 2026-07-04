// Teacher Scenes — named, reusable allowed-website lists (GoGuardian
// "Scenes"). A scene is just a saved allowed_domains list; applying one
// happens client-side by pre-filling the Start Lesson modal, so enforcement
// rides the existing lesson_sessions.allowed_domains mechanism untouched.
// Strictly teacher-owned: every route scopes to the caller's own rows
// (admins get no cross-teacher access here — a scene is personal prep
// material, not district config).

const { Router } = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { isValidDomain } = require('../services/goguardianImport');

const router = Router();
router.use(authenticate, requireMinRole('teacher'));

const MAX_SCENES = 100;
const MAX_DOMAINS = 200;

// Same normalization the Start Lesson modal applies before submitting, so a
// pasted URL or wildcard saves cleanly; invalid entries are rejected loudly
// rather than silently dropped (a teacher should know their scene is short).
function normalizeDomains(raw) {
  if (!Array.isArray(raw)) return { error: 'allowed_domains must be an array' };
  if (raw.length > MAX_DOMAINS) return { error: `Too many domains (max ${MAX_DOMAINS})` };
  const domains = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return { error: 'Domains must be strings' };
    const d = entry.trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*\./, '');
    if (!d) continue;
    if (!isValidDomain(d)) return { error: `"${entry}" is not a valid domain` };
    if (!domains.includes(d)) domains.push(d);
  }
  return { domains };
}

// GET /scenes — caller's own scenes
router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, description, allowed_domains, created_at, updated_at
     FROM teacher_scenes WHERE teacher_id = $1 ORDER BY name`,
    [req.user.userId]
  );
  res.json(rows);
});

// POST /scenes — create
router.post('/', async (req, res) => {
  const { name, description, allowed_domains } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const { domains, error } = normalizeDomains(allowed_domains || []);
  if (error) return res.status(400).json({ error });
  if (!domains.length) return res.status(400).json({ error: 'At least one valid domain is required' });

  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM teacher_scenes WHERE teacher_id = $1`,
    [req.user.userId]
  );
  if (count >= MAX_SCENES) return res.status(400).json({ error: `Scene limit reached (${MAX_SCENES})` });

  try {
    const { rows: [scene] } = await query(
      `INSERT INTO teacher_scenes (teacher_id, name, description, allowed_domains)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, allowed_domains, created_at, updated_at`,
      [req.user.userId, name.trim(), description || null, JSON.stringify(domains)]
    );
    res.status(201).json(scene);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have a scene with that name' });
    }
    throw err;
  }
});

// PUT /scenes/:id — update own scene
router.put('/:id', async (req, res) => {
  const { name, description, allowed_domains } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const { domains, error } = normalizeDomains(allowed_domains || []);
  if (error) return res.status(400).json({ error });
  if (!domains.length) return res.status(400).json({ error: 'At least one valid domain is required' });

  try {
    const { rows: [scene] } = await query(
      `UPDATE teacher_scenes
       SET name = $3, description = $4, allowed_domains = $5, updated_at = now()
       WHERE id = $1 AND teacher_id = $2
       RETURNING id, name, description, allowed_domains, created_at, updated_at`,
      [req.params.id, req.user.userId, name.trim(), description || null, JSON.stringify(domains)]
    );
    if (!scene) return res.status(404).json({ error: 'Scene not found' });
    res.json(scene);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have a scene with that name' });
    }
    throw err;
  }
});

// DELETE /scenes/:id — delete own scene
router.delete('/:id', async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM teacher_scenes WHERE id = $1 AND teacher_id = $2`,
    [req.params.id, req.user.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Scene not found' });
  res.json({ ok: true });
});

module.exports = router;
