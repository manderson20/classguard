-- Generalizes HA from a binary primary/secondary model to an ordered N-node
-- failover list. Stores the actual VRRP priority value (1-255, higher wins)
-- directly on each node rather than an abstract rank (1st/2nd/3rd) that would
-- need translating back and forth — one fewer place for numbers to drift.
-- Existing radius_ha_config.priority_primary/priority_secondary (migration
-- 014) stay as legacy defaults for newly-joined nodes; this column is the
-- new source of truth for keepalived.js's config generation.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS failover_priority SMALLINT NOT NULL DEFAULT 100;

CREATE INDEX IF NOT EXISTS idx_nodes_failover_priority ON nodes (failover_priority DESC);
