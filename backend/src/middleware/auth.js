const jwt = require('jsonwebtoken');
const config = require('../config');

// Internal services (dns-engine) call a handful of routes server-to-server
// with no user session — e.g. resolving a student's effective policy on a
// DNS query. They authenticate with a shared secret instead of a JWT, same
// pattern as routes/radius.js's radiusSecret middleware. Granted the highest
// role so requireMinRole() checks downstream pass naturally.
function isInternalRequest(req) {
  const secret = process.env.INTERNAL_SECRET;
  return !!secret && req.headers['x-internal-secret'] === secret;
}

const authenticate = (req, res, next) => {
  if (isInternalRequest(req)) {
    req.user = { userId: null, email: 'internal-service', role: 'superadmin' };
    return next();
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, config.jwt.secret);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = { authenticate };
