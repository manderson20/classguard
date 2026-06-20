-- Tracks pending/in-progress/completed software updates, one row per node.
-- Lives only on the primary's writable database — a standby can't write to
-- its own (read-only) copy, so its host-level updater (see
-- infrastructure/update-watcher) reads its own row by relaying through its
-- local API to the primary, same pattern as DNS log forwarding / VRRP state.
CREATE TABLE IF NOT EXISTS update_schedule (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id       VARCHAR(255) NOT NULL,
  target_version VARCHAR(50) NOT NULL,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | in_progress | completed | failed
  requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  log           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- Only one active (pending/in_progress) schedule per node at a time.
CREATE UNIQUE INDEX IF NOT EXISTS update_schedule_one_active_per_node
  ON update_schedule (node_id)
  WHERE status IN ('pending', 'in_progress');
