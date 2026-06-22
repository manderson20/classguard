const { hasPermission } = require('../services/permissions');

const ROLE_HIERARCHY = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

// Drop-in replacement for requireMinRole('admin') at any gate site that
// should be delegatable via a custom role — enforces the same admin-tier
// minimum today's requireMinRole('admin') does, then narrows further based
// on the requesting user's effective permissions (full access unless
// they're restricted to a specific custom role). superadmin always passes.
const requirePermission = (key) => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if ((ROLE_HIERARCHY[req.user.role] ?? -1) < ROLE_HIERARCHY.admin) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const allowed = await hasPermission(req.user.userId, req.user.role, key).catch(() => false);
  if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
};

// For routes already gated requireMinRole('teacher') where a teacher must
// keep full (roster-scoped) access unconditionally — e.g. extension.js's
// screenshots/browser-history, dns.js's logs/stats, policies.js's simulate
// — but an 'admin'-tier caller on the same route should still be subject to
// the custom-permission restriction. No-op for teacher/superadmin/student.
const requirePermissionIfAdmin = (key) => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return next();
  const allowed = await hasPermission(req.user.userId, req.user.role, key).catch(() => false);
  if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
};

module.exports = { requirePermission, requirePermissionIfAdmin };
