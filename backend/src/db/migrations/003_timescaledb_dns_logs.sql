-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Convert dns_logs into a hypertable partitioned by queried_at (1-day chunks)
-- IMPORTANT: run BEFORE inserting data; no-op if already a hypertable.
SELECT create_hypertable(
  'dns_logs',
  'queried_at',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists       => TRUE
);

-- Compress chunks older than 2 days, segmented by user so per-user queries
-- scan only one segment within a compressed chunk.
ALTER TABLE dns_logs SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id',
  timescaledb.compress_orderby   = 'queried_at DESC'
);

SELECT add_compression_policy('dns_logs', INTERVAL '2 days', if_not_exists => TRUE);

-- Configurable data-retention policy (default 90 days); edit via Admin UI.
SELECT add_retention_policy('dns_logs', INTERVAL '90 days', if_not_exists => TRUE);

-- Continuous aggregate: hourly summary used by the DNS stats dashboard.
-- Refreshed automatically every 30 minutes, covering a 1-hour lag window.
CREATE MATERIALIZED VIEW IF NOT EXISTS dns_stats_hourly
WITH (timescaledb.continuous) AS
  SELECT
    time_bucket('1 hour', queried_at)  AS bucket,
    user_id,
    action,
    COUNT(*)                           AS total_queries,
    COUNT(DISTINCT domain)             AS unique_domains
  FROM dns_logs
  GROUP BY bucket, user_id, action
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'dns_stats_hourly',
  start_offset  => INTERVAL '2 days',
  end_offset    => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes',
  if_not_exists => TRUE
);

-- Useful indices for ad-hoc queries not covered by the aggregate
CREATE INDEX IF NOT EXISTS dns_logs_user_queried ON dns_logs (user_id, queried_at DESC);
CREATE INDEX IF NOT EXISTS dns_logs_domain       ON dns_logs (domain);
CREATE INDEX IF NOT EXISTS dns_logs_action       ON dns_logs (action, queried_at DESC);
