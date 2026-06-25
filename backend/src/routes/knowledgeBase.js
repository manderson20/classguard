// One knowledge base for every help guide in the app (see migration
// 073_knowledge_base.sql). Reading is open to any authenticated staff
// member -- help content should never be harder to reach than the feature
// it documents. Authoring is gated by 'knowledge_base' since letting any
// teacher rewrite admin-facing docs would be its own kind of mess.
const { Router } = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const { requirePermissionIfAdmin } = require('../middleware/permissions');

const router = Router();
const readAuth  = [authenticate, requireMinRole('teacher')];
const writeAuth = [authenticate, requireMinRole('admin'), requirePermissionIfAdmin('knowledge_base')];

router.get('/', ...readAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, slug, title, category, page_paths, updated_at FROM kb_articles ORDER BY category, title`
  );
  res.json(rows);
});

// Resolve the article(s) relevant to a given app route -- powers the
// floating help button on each page. Matches on exact path or prefix
// (so an article tagged '/admin/dns' also surfaces for '/admin/dns/logs').
router.get('/for-page', ...readAuth, async (req, res) => {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path is required' });
  const { rows } = await pool.query(
    `SELECT id, slug, title, category FROM kb_articles
     WHERE EXISTS (SELECT 1 FROM unnest(page_paths) p WHERE $1 = p OR $1 LIKE p || '/%')
     ORDER BY title`,
    [path]
  );
  res.json(rows);
});

router.get('/:slug', ...readAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM kb_articles WHERE slug = $1`, [req.params.slug]);
  if (!rows.length) return res.status(404).json({ error: 'Article not found' });
  res.json(rows[0]);
});

router.post('/', ...writeAuth, async (req, res) => {
  const { slug, title, category, content, page_paths = [] } = req.body;
  if (!slug || !title || !category || !content) return res.status(400).json({ error: 'slug, title, category, and content are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO kb_articles (slug, title, category, content, page_paths, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [slug, title, category, content, page_paths, req.user.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An article with this slug already exists' });
    throw err;
  }
});

router.put('/:id', ...writeAuth, async (req, res) => {
  const { title, category, content, page_paths } = req.body;
  const { rows } = await pool.query(
    `UPDATE kb_articles SET
       title = COALESCE($2, title), category = COALESCE($3, category),
       content = COALESCE($4, content), page_paths = COALESCE($5, page_paths),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [req.params.id, title, category, content, page_paths]
  );
  if (!rows.length) return res.status(404).json({ error: 'Article not found' });
  res.json(rows[0]);
});

router.delete('/:id', ...writeAuth, async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM kb_articles WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Article not found' });
  res.json({ deleted: true });
});

module.exports = router;
