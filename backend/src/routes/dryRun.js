const express           = require('express');
const router            = express.Router();
const redis             = require('../redis');
const { query }         = require('../db');
const { authenticate }  = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');

const DRY_RUN_KEY     = 'classguard:dry-run';
const VALID_DURATIONS = [30, 60, 120, 240]; // minutes
const CONFIRMATION    = 'CONFIRM';

// ---------------------------------------------------------------------------
// GET /api/v1/dry-run  — current state (admin+)
// ---------------------------------------------------------------------------
router.get('/', authenticate, requireMinRole('admin'), async (req, res) => {
  try {
    const raw = await redis.get(DRY_RUN_KEY);
    if (!raw) return res.json({ active: false });
    const state = JSON.parse(raw);
    if (state.expiresAt && Date.now() > state.expiresAt) {
      await redis.del(DRY_RUN_KEY).catch(() => {});
      await query(`DELETE FROM settings WHERE key = 'dry_run_state'`).catch(() => {});
      return res.json({ active: false });
    }
    return res.json({
      active:          true,
      expiresAt:       state.expiresAt,
      durationMinutes: state.durationMinutes,
      enabledBy:       state.enabledBy,
      enabledAt:       state.enabledAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/dry-run  — enable (superadmin only)
// Body: { duration: 30|60|120|240, confirmation: 'CONFIRM' }
// ---------------------------------------------------------------------------
router.post('/', authenticate, requireMinRole('superadmin'), async (req, res) => {
  const { duration, confirmation } = req.body;

  if (confirmation !== CONFIRMATION) {
    return res.status(400).json({ error: `Type ${CONFIRMATION} to confirm` });
  }
  const dur = Number(duration);
  if (!VALID_DURATIONS.includes(dur)) {
    return res.status(400).json({ error: `Duration must be one of: ${VALID_DURATIONS.join(', ')} minutes` });
  }

  const expiresAt = Date.now() + dur * 60 * 1000;
  const state = {
    active:          true,
    expiresAt,
    durationMinutes: dur,
    enabledBy:       req.user.email || req.user.userId,
    enabledAt:       Date.now(),
  };

  try {
    // DB write first — if Postgres is unavailable the Redis key never gets
    // set, so the DNS engine stays in filtering mode and the 500 is accurate.
    await query(
      `INSERT INTO settings (key, value) VALUES ('dry_run_state', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(state)]
    );
    try {
      await redis.set(DRY_RUN_KEY, JSON.stringify(state), 'EX', dur * 60);
    } catch (redisErr) {
      // Redis write failed after DB succeeded — roll back so state stays
      // consistent (filtering is NOT bypassed) and return 500.
      await query(`DELETE FROM settings WHERE key = 'dry_run_state'`).catch(() => {});
      throw redisErr;
    }
    res.json({ active: true, expiresAt, durationMinutes: dur });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/dry-run  — disable early (superadmin only)
// ---------------------------------------------------------------------------
router.delete('/', authenticate, requireMinRole('superadmin'), async (req, res) => {
  try {
    await redis.del(DRY_RUN_KEY);
    await query(`DELETE FROM settings WHERE key = 'dry_run_state'`);
    res.json({ active: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
