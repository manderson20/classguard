-- Add unique constraint on nodes.hostname so the heartbeat upsert works correctly.
-- Nodes are identified by hostname; this allows ON CONFLICT (hostname) DO UPDATE.
ALTER TABLE nodes ADD CONSTRAINT nodes_hostname_unique UNIQUE (hostname);
