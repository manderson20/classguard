// Encodes a role dropdown selection as a single string so one <select> can
// offer the four base roles (always available, no API round-trip needed —
// the backend auto-resolves the matching builtin custom_role_id when none
// is given) plus any user-created custom role (admin-tier only) fetched
// from GET /custom-roles, instead of two separate role/custom-role pickers.
export const BASE_ROLES = [
  { value: 'student',    label: 'Student' },
  { value: 'teacher',    label: 'Teacher' },
  { value: 'admin',      label: 'Admin' },
  { value: 'superadmin', label: 'Super Admin' },
];

export function roleOptionsFromCustomRoles(customRoles) {
  const custom = customRoles.filter(r => !r.is_builtin);
  return [
    ...BASE_ROLES,
    ...custom.map(r => ({ value: `custom:${r.id}`, label: r.name })),
  ];
}

// value -> { role, custom_role_id } body fields for the create/role-change APIs.
// custom_role_id is omitted (not null) for base roles so the backend's
// "default to the builtin row" logic applies instead of explicitly clearing it.
export function decodeRoleValue(value) {
  if (value.startsWith('custom:')) {
    return { role: 'admin', custom_role_id: value.slice('custom:'.length) };
  }
  return { role: value };
}

// A user's {role, custom_role_id} -> dropdown value. Needs the custom roles
// list to tell whether custom_role_id points at a builtin row (in which
// case the base role string alone already represents it) or a real custom
// role (which needs its own `custom:<id>` option).
export function encodeRoleValue(user, customRoles) {
  if (user.custom_role_id) {
    const assigned = customRoles.find(r => r.id === user.custom_role_id);
    if (assigned && !assigned.is_builtin) return `custom:${user.custom_role_id}`;
  }
  return user.role;
}
