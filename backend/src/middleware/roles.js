const ROLE_HIERARCHY = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

const requireMinRole = (minRole) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const userLevel = ROLE_HIERARCHY[req.user.role] ?? -1;
  const minLevel  = ROLE_HIERARCHY[minRole]      ?? 99;
  if (userLevel < minLevel) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

module.exports = { requireRole, requireMinRole };
