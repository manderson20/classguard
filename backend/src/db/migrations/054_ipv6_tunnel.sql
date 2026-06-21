-- Optional Hurricane Electric 6in4 tunnel, for districts whose ISP doesn't
-- offer native IPv6 (this one doesn't). Off by default - a district with
-- native ISP IPv6 wouldn't enable this at all. Singleton settings table,
-- same shape as ntp_server_config (048) and vpn_config (052).
--
-- ClassGuard terminates the tunnel and is the IPv6 *uplink* only - it does
-- not become the LAN's IPv6 router. routed_prefix/local_ipv6 are the two
-- values an admin manually enters as a static route in UniFi (destination/
-- next-hop) so UniFi keeps doing RA/SLAAC distribution itself, exactly as
-- it already does for IPv4. UniFi's API here is read-only (confirmed against
-- services/network/unifi.js - GET inventory only, no POST/PUT anywhere), so
-- this one step can't be automated.
CREATE TABLE IF NOT EXISTS ipv6_tunnel_config (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled        BOOLEAN     NOT NULL DEFAULT false,
  he_user_id     TEXT,
  he_tunnel_id   TEXT,
  he_server_ipv4 INET,        -- Hurricane Electric's PoP endpoint
  he_client_ipv4 INET,        -- this host's public IPv4 - the tunnel's local endpoint
  routed_prefix  CIDR,        -- the /64 (or /48) HE assigns
  local_ipv6     INET,        -- this host's address on the tunnel - the next-hop UniFi's static route points to
  last_status    TEXT,        -- 'up' / 'down', from the health-check cron's reports
  last_seen_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ipv6_tunnel_config DEFAULT VALUES ON CONFLICT DO NOTHING;
