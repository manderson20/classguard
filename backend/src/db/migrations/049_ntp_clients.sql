-- Visibility into who's actually polling ClassGuard's NTP server (chrony),
-- once an admin has deployed it (see 048_ntp_server.sql / services/chrony.js).
-- chrony itself only ever exposes a rolling snapshot per client (cumulative
-- packet count since chronyd's last restart, seconds since its last packet)
-- via `chronyc clients` — there's no per-request timestamp to log, so this
-- mirrors that shape (an upsert-by-client snapshot, like `nodes`' own
-- last_seen tracking) rather than a discrete event log like dns_logs.
CREATE TABLE IF NOT EXISTS ntp_clients (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         TEXT        NOT NULL,
  client_address  INET        NOT NULL,
  ntp_packets     INTEGER     NOT NULL DEFAULT 0,
  ntp_dropped     INTEGER     NOT NULL DEFAULT 0,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (node_id, client_address)
);

CREATE INDEX IF NOT EXISTS idx_ntp_clients_last_seen ON ntp_clients (last_seen_at DESC);
