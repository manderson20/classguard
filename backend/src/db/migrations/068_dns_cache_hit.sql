-- Tracks whether an allowed DNS query was served from dns-engine's Redis
-- response cache (cache.js) or required a real upstream lookup, so the
-- hit rate can be shown/reported on instead of just trusted to exist.
-- NULL for blocked/local queries -- they never reach the cache at all, a
-- different fact than "checked the cache and missed" (cache_hit = false).
ALTER TABLE dns_logs ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN;
