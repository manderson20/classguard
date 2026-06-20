-- http01 was added to acmeTls.js / the TLS settings UI as a validation
-- method, but the original tls_config check constraint (027_tls.sql) was
-- never updated to allow it — every attempt to save provider='http01'
-- failed with "violates check constraint tls_config_provider_check".
ALTER TABLE tls_config DROP CONSTRAINT IF EXISTS tls_config_provider_check;
ALTER TABLE tls_config ADD CONSTRAINT tls_config_provider_check
  CHECK (provider IN ('cloudflare', 'route53', 'manual', 'http01'));
