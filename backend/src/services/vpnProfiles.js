// Resolves which VPN profile a connecting client belongs to. The only
// identity ClassGuard ever sees at the VPN layer is the connecting cert's
// CN -- every documented enrollment path on the VPN page already sets that
// to the connecting user's real email, so this just looks that email up
// against users/groups the same way radius.js resolves Wi-Fi policies:
// a direct user assignment wins over a group assignment, and anyone with
// neither (including unknown/non-email CNs) falls back to the one
// is_default profile.
const { pool } = require('../db');

async function resolveProfileForCn(certCn) {
  const email = (certCn || '').trim().toLowerCase();

  const { rows: [user] } = email
    ? await pool.query('SELECT id FROM users WHERE lower(email) = $1', [email])
    : { rows: [] };

  if (!user) {
    const { rows: [fallback] } = await pool.query('SELECT * FROM vpn_profiles WHERE is_default LIMIT 1');
    return fallback || null;
  }

  const { rows: [profile] } = await pool.query(
    `SELECT p.*
     FROM vpn_profiles p
     LEFT JOIN vpn_profile_assignments ua ON ua.profile_id = p.id AND ua.user_id = $1
     LEFT JOIN vpn_profile_assignments ga ON ga.profile_id = p.id
       AND ga.group_id IN (SELECT group_id FROM group_members WHERE user_id = $1)
     WHERE ua.id IS NOT NULL OR ga.id IS NOT NULL OR p.is_default
     ORDER BY (ua.id IS NOT NULL) DESC, (ga.id IS NOT NULL) DESC, (p.is_default) ASC
     LIMIT 1`,
    [user.id]
  );
  return profile || null;
}

module.exports = { resolveProfileForCn };
