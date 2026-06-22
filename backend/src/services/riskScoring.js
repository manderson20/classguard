const { query } = require('../db');

// Rule-based risk scoring for the Safety Evidence Capture feature — works
// with zero AI configuration. AI vision analysis (analyseScreenshot in
// extension.js) is a separate, optional second opinion layered on top once
// a provider is configured; this is the baseline signal admins always get.
//
// Base weights per category, loosely following the design doc's example
// scoring (self_harm/violence highest, then weapons/hate, then the rest).
// Categories not listed fall back to UNKNOWN_BASE.
const CATEGORY_WEIGHTS = {
  self_harm:      95,
  violence:       90,
  weapons:        85,
  hate_speech:    75,
  drugs_alcohol:  65,
  adult:          60,
  phishing:       55,
  malware:        55,
  gambling:       50,
  proxy_vpn:      40,
  torrent:        35,
  dating:         35,
  profanity:      30, // default content_keywords category for anything uncategorized
};
const UNKNOWN_BASE = 25; // fully uncategorized domain — lowest-confidence signal, still worth a look

const REPEAT_WINDOW_HOURS = 24;
const REPEAT_MODIFIER     = 20;
const REPEAT_MODIFIER_CAP = 40; // at most +40 regardless of how many repeats

function baseScoreForCategory(category) {
  return CATEGORY_WEIGHTS[category] ?? UNKNOWN_BASE;
}

// action: 'allowed' | 'blocked' | null/undefined.
// 'allowed' means the content actually rendered (worse — they saw it).
// 'blocked' means a block fired but they still attempted it (lesser, but
// still evidence of intent).
function actionModifier(action) {
  if (action === 'allowed') return 20;
  if (action === 'blocked') return 10;
  return 0;
}

async function repeatModifier(studentId, category) {
  if (!category) return 0;
  const { rows } = await query(
    `SELECT COUNT(*) AS n FROM screenshots
     WHERE student_id = $1 AND risk_category = $2 AND created_at > NOW() - INTERVAL '${REPEAT_WINDOW_HOURS} hours'`,
    [studentId, category]
  );
  const priorCount = parseInt(rows[0]?.n || '0', 10);
  return Math.min(priorCount * REPEAT_MODIFIER, REPEAT_MODIFIER_CAP);
}

// Returns { score, tier } where tier is purely descriptive (used for
// badges/sorting) — it is NOT the workflow `status` column, which tracks
// the review ticket lifecycle (new/in_review/resolved/dismissed) instead.
function tierForScore(score) {
  if (score >= 85) return 'urgent';
  if (score >= 60) return 'needs_review';
  if (score >= 40) return 'logged';
  return 'low';
}

async function computeRiskScore({ studentId, category, action }) {
  const base   = baseScoreForCategory(category);
  const repeat = await repeatModifier(studentId, category);
  const score  = Math.min(base + actionModifier(action) + repeat, 100);
  return { score, tier: tierForScore(score) };
}

module.exports = { computeRiskScore, tierForScore, CATEGORY_WEIGHTS, UNKNOWN_BASE };
