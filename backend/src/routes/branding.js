const express = require('express');
const router  = express.Router();
const { pool } = require('../db');

const BRANDING_KEYS = [
  'blockpage_school_name',
  'blockpage_logo',
  'blockpage_message',
  'blockpage_contact_email',
  'blockpage_primary_color',
  'unblock_requests_who',
  'override_codes_enabled',
];

// GET /api/v1/branding — public, no auth required
// Used by the DNS sinkhole block page and the Chrome extension blocked.html
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
      [BRANDING_KEYS]
    );
    const data = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      school_name:            data.blockpage_school_name   || null,
      logo:                   data.blockpage_logo           || null,
      message:                data.blockpage_message        || null,
      contact_email:          data.blockpage_contact_email  || null,
      primary_color:          data.blockpage_primary_color  || '#2563eb',
      unblock_requests_who:   data.unblock_requests_who     || 'all',
      override_codes_enabled: data.override_codes_enabled   !== 'false',
    });
  } catch (err) {
    console.error('[branding] GET error:', err);
    res.status(500).json({ error: 'Failed to load branding' });
  }
});

module.exports = router;
