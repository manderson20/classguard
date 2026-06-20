-- The original policy lagged the dashboard by up to 1.5 hours (30 min
-- schedule + 1 hour end_offset), since the most recent partial hour is
-- intentionally excluded from the materialized bucket. For a 24h/1h-bucket
-- view that's the entire most-recent-activity window appearing empty.
-- Tighten both knobs; the API route also unions in a live "tail" query
-- against raw dns_logs for anything newer than the aggregate has caught up
-- to, so this just shrinks how much of that tail query has to scan.
SELECT remove_continuous_aggregate_policy('dns_stats_hourly', if_exists => TRUE);

SELECT add_continuous_aggregate_policy(
  'dns_stats_hourly',
  start_offset      => INTERVAL '2 days',
  end_offset        => INTERVAL '10 minutes',
  schedule_interval  => INTERVAL '5 minutes',
  if_not_exists      => TRUE
);
