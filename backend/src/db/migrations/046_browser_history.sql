-- Durable storage for the extension's tab-navigation events. The capture
-- and live-teacher-view path already existed (routes/extension.js's
-- /tab-event writes to Redis stream 'classguard:tab-events' and emits a
-- socket event) but nothing ever drained that stream to Postgres — it was
-- capped at ~10k entries with no retrievable history once that filled.
-- Mirrors dns_logs (migration 003) exactly: same hypertable/compression/
-- retention shape, since it's the same kind of high-volume per-user
-- timestamped event data.
CREATE TABLE browser_history (
  id           BIGSERIAL,
  user_id      UUID REFERENCES users(id),
  device_id    UUID REFERENCES devices(id),
  url          TEXT NOT NULL,
  title        VARCHAR(500),
  action       VARCHAR(20),           -- 'allowed' | 'blocked' | NULL (unknown — no dns_logs match found)
  block_reason VARCHAR(255),
  visited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, visited_at)        -- TimescaleDB requires the partition column in the PK
);

SELECT create_hypertable(
  'browser_history',
  'visited_at',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists       => TRUE
);

ALTER TABLE browser_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id',
  timescaledb.compress_orderby   = 'visited_at DESC'
);

SELECT add_compression_policy('browser_history', INTERVAL '2 days', if_not_exists => TRUE);

-- 90 days, matching dns_logs' default retention.
SELECT add_retention_policy('browser_history', INTERVAL '90 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS browser_history_user_visited ON browser_history (user_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS browser_history_device_visited ON browser_history (device_id, visited_at DESC);
