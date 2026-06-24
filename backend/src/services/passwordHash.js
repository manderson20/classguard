// Shared by auth.js (login/setup) and users.js (admin-created local
// accounts, password resets) — kept in one place since password hashing is
// exactly the kind of logic that should never silently drift between two
// copies.
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const input = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), input);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
