-- Tracks whether a user's role came from auto-detection (Google OU sync /
-- first SSO login) or an explicit admin override via PUT /users/:id/role.
-- Without this, every Google-synced or SSO-created account is forced into
-- 'student' (the column default) since neither path has ever set role from
-- OU data — staff accounts included. Auto-detection needs a way to never
-- clobber a role an admin deliberately set.
ALTER TABLE users ADD COLUMN role_source VARCHAR(20) NOT NULL DEFAULT 'auto';

-- Every existing non-student role got there through deliberate action (the
-- initial superadmin bootstrap, or a manual PUT /users/:id/role) — sync and
-- SSO login have only ever defaulted new rows to 'student' until now, so
-- this is a safe one-time inference, not a guess.
UPDATE users SET role_source = 'manual' WHERE role != 'student';
