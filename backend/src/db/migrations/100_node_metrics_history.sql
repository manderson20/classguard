-- Per-node metrics snapshots for the wallboard history graphs. Written once
-- a minute by the primary's scheduler (a standby's replica is read-only, so
-- the primary samples its peers over HTTP and records for everyone), pruned
-- to 48 hours by the same job. The full /metrics JSON is stored rather than
-- picked-apart columns so new metrics need no schema change; the history
-- endpoint extracts a fixed allowlist of keys.

CREATE TABLE IF NOT EXISTS node_metrics_history (
  node_id    TEXT        NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metrics    JSONB       NOT NULL,
  PRIMARY KEY (node_id, sampled_at)
);

CREATE INDEX IF NOT EXISTS idx_node_metrics_history_sampled_at
  ON node_metrics_history (sampled_at);
