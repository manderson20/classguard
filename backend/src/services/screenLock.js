// Remembers which students' screens a teacher has locked, so a class page
// opened (or reloaded) later shows the right Lock / Unlock state. The lock
// itself lives in the student's extension; this is only its mirror, kept up
// to date by the lock/unlock relay in sockets/index.js — the single path
// every lock and unlock (class cards, Live View, ClassPulse, End Class)
// goes through. Each node's Redis sees the requests made to that node,
// which is where the teacher's class page is served from too.
//
// The 12-hour expiry only stops a mirror entry outliving the school day if
// an unlock never came through this node; it isn't a lock timeout.
const redis = require('../redis');

const LOCK_TTL_SECONDS = 12 * 60 * 60;

function screenLockKey(studentId) {
  return `teacher:screen_locked:${studentId}`;
}

async function recordScreenLock(studentId, locked) {
  if (!studentId) return;
  if (locked) await redis.set(screenLockKey(studentId), '1', 'EX', LOCK_TTL_SECONDS);
  else await redis.del(screenLockKey(studentId));
}

module.exports = { screenLockKey, recordScreenLock };
