-- Migration 027: TLS certificate automation via ACME DNS-01 (Let's Encrypt).
-- DNS-01 verifies domain ownership with a DNS TXT record instead of an
-- inbound HTTP request, so issuance works without port-forwarding or a
-- dedicated public IP per node — the cert is issued for the VRRP VIP's
-- hostname and lives in shared Postgres so any HA node can serve it.

CREATE TABLE IF NOT EXISTS tls_config (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled                     BOOLEAN     NOT NULL DEFAULT false,
  domain                      TEXT,
  acme_email                  TEXT,
  provider                    TEXT        NOT NULL DEFAULT 'manual'
                                           CHECK (provider IN ('cloudflare', 'route53', 'manual')),

  cloudflare_api_token        TEXT,
  cloudflare_zone_id          TEXT,
  route53_access_key_id       TEXT,
  route53_secret_access_key   TEXT,
  route53_hosted_zone_id      TEXT,

  account_key_pem             TEXT,        -- ACME account key, generated on first use
  cert_pem                    TEXT,
  privkey_pem                 TEXT,
  cert_issued_at              TIMESTAMPTZ,
  cert_expires_at             TIMESTAMPTZ,

  last_error                  TEXT,
  last_attempt_at             TIMESTAMPTZ,

  -- In-flight manual DNS-01 challenge: order/authz/challenge JSON + the
  -- pending cert key/csr (base64 DER), cleared once issuance completes.
  manual_challenge            JSONB,

  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tls_config DEFAULT VALUES ON CONFLICT DO NOTHING;
