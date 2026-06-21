#!/bin/sh
set -e

# Waits for the admin to have generated a CA and enabled SCEP (VPN page) -
# unlike the vpn container, there's no host networking/iptables to set up
# here, just two files and a binary. CA material rarely changes once
# generated, so this is a wait-then-exec, not a continuous reconcile loop -
# same accepted limitation vpn-agent.py already has for its own CA trust:
# disabling after the fact requires restarting this container, since an
# already-running scepserver doesn't get torn down retroactively.
while true; do
  CFG="$(curl -fsS -H "X-Internal-Secret: ${INTERNAL_SECRET}" http://api:3001/api/v1/vpn/scep-bootstrap || true)"
  ENABLED="$(echo "$CFG" | jq -r '.enabled // false' 2>/dev/null || echo false)"
  CA_CERT="$(echo "$CFG" | jq -r '.ca_cert_pem // empty' 2>/dev/null || true)"

  if [ "$ENABLED" = "true" ] && [ -n "$CA_CERT" ]; then
    break
  fi
  sleep 30
done

CA_KEY="$(echo "$CFG" | jq -r '.ca_private_key_pem // empty')"
CHALLENGE="$(echo "$CFG" | jq -r '.scep_challenge // empty')"

mkdir -p /depot
printf '%s' "$CA_CERT" > /depot/ca.pem
printf '%s' "$CA_KEY"  > /depot/ca.key
chmod 600 /depot/ca.key

# crtvalid: how long an issued client cert is valid for, in days. 730 (2yr)
# rather than the server's own 365-day default — staff re-enrolling via
# Mosyle is friction worth avoiding more than half as often.
exec scepserver -port 8080 -depot /depot -challenge "$CHALLENGE" -crtvalid 730
