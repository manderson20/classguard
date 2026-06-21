-- Self-hosted IKEv2 VPN (StrongSwan) for staff remote access. Auth is
-- certificate-based, trusting Mosyle's own SCEP-issued device/user certs —
-- ClassGuard never issues or manages client certs itself, just needs to
-- trust Mosyle's CA (mosyle_ca_pem) for validating incoming connections.
--
-- Singleton settings table, same shape as ntp_server_config (048): one row,
-- read by a config generator (services/strongswan.js), seeded so the UI can
-- always read/update it.
CREATE TABLE IF NOT EXISTS vpn_config (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled            BOOLEAN     NOT NULL DEFAULT false,
  mosyle_ca_pem      TEXT,
  client_subnet      CIDR        NOT NULL DEFAULT '10.99.99.0/24',
  dns_servers        INET[]      NOT NULL DEFAULT '{}',
  -- Optional allow-list of internal subnets a connected client may reach.
  -- Empty/null = full network access (a traditional perimeter VPN, not
  -- ZTNA) — this is the lighter-weight middle ground discussed with the
  -- admin: real value without building a full per-resource access broker.
  restrict_to_subnets CIDR[]     NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO vpn_config DEFAULT VALUES ON CONFLICT DO NOTHING;

-- Session visibility — both live and historical. Rows are written by the
-- backend reconciling the vpn container's periodic status push (the
-- container can't be polled the normal Docker-DNS way since it runs with
-- network_mode: host to do IKEv2/ESP correctly, same reasoning that already
-- puts keepalived itself directly on the host rather than in a container).
CREATE TABLE IF NOT EXISTS vpn_clients (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_cn         TEXT        NOT NULL,
  assigned_ip     INET,
  real_ip         INET,
  bytes_in        BIGINT      NOT NULL DEFAULT 0,
  bytes_out       BIGINT      NOT NULL DEFAULT 0,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vpn_clients_active ON vpn_clients (cert_cn) WHERE disconnected_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vpn_clients_connected_at ON vpn_clients (connected_at DESC);
