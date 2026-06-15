-- Migration 006: unique index on groups.google_group_email for Google Workspace sync upserts
-- Allows multiple NULL values (groups not backed by Google) while enforcing uniqueness
-- for rows that do have a google_group_email.

CREATE UNIQUE INDEX IF NOT EXISTS groups_google_group_email_unique
  ON groups (google_group_email)
  WHERE google_group_email IS NOT NULL;
