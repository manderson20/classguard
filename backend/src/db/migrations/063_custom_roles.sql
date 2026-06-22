-- Custom permissions/roles for admin-tier users. Lets a superadmin grant an
-- 'admin'-role user access to only some admin feature areas (Users,
-- Unblock Requests, ...) instead of the whole admin surface. A user with
-- custom_role_id = NULL is unrestricted (today's default behavior,
-- unchanged); setting it restricts them to exactly that role's permission
-- set. See backend/src/services/permissions.js for the permission catalog
-- and effective-permission resolution.
CREATE TABLE custom_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE custom_role_permissions (
  role_id        UUID NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
  permission_key VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_role_id UUID REFERENCES custom_roles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_custom_role ON users(custom_role_id) WHERE custom_role_id IS NOT NULL;
