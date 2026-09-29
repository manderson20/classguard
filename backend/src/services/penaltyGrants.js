// Approving a Penalty Box "Allow site…" request (unblock_requests.penalty_box_id
// set) lets that student reach the site for the rest of the restriction it
// was made for — whichever way the admin approves it (plain Approve in
// routes/unblockRequests.js, or "+ Code" in routes/overrideCodes.js). A
// temporary override code alone can't do it: DNS and the extension apply
// the penalty_box block before override codes. Ordinary requests grant
// nothing here.
const { pool } = require('../db');
const { invalidatePolicy } = require('./policyResolver');
const events = require('../events');

// request: an unblock_requests row. Returns true if a site was granted.
async function grantApprovedPenaltyRequest(request) {
  if (!request?.penalty_box_id || !request.domain) return false;
  const { rows: [pb] } = await pool.query(
    `UPDATE penalty_box
        SET allowed_domains = allowed_domains || to_jsonb($2::text)
      WHERE id = $1 AND released_at IS NULL
        AND NOT allowed_domains ? $2
      RETURNING student_id`,
    [request.penalty_box_id, request.domain]
  );
  if (!pb) return false;
  await invalidatePolicy(pb.student_id);
  events.emit('policy:updated', { studentId: pb.student_id });
  return true;
}

module.exports = { grantApprovedPenaltyRequest };
