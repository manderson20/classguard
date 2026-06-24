#!/bin/bash
# Reconciles this host's ufw rules with what ha.js's GET /firewall-rules
# says they should be right now, given this node's actual role and the
# cluster's current membership. Idempotent -- safe to run from install.sh
# once AND from the update-watcher's timer every minute (see
# infrastructure/update-watcher/update-watcher.sh).
#
# Talks only to localhost:3001 -- same trust boundary as every other
# host-level script in this project (keepalived's health check, the update
# watcher itself). Does nothing destructive if the API isn't reachable yet
# (e.g. very first boot, before containers are up) -- just exits quietly.
set -uo pipefail

RESPONSE=$(curl -sf http://localhost:3001/api/v1/ha/firewall-rules) || exit 0
[ -z "$RESPONSE" ] && exit 0

if ! command -v ufw >/dev/null 2>&1 || ! command -v fail2ban-client >/dev/null 2>&1; then
  apt-get install -y ufw fail2ban >/dev/null 2>&1 || exit 0
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || true

# Static rules first -- SSH is always first in the array ha.js sends, so by
# the time `ufw enable` below ever runs (only if not already active), SSH
# is already allowed. `ufw allow` is a no-op if the exact rule already
# exists, so running this every minute from the watcher is harmless.
echo "$RESPONSE" | jq -c '.static_rules[]' | while read -r rule; do
  PROTO=$(echo "$rule" | jq -r '.proto')
  COMMENT=$(echo "$rule" | jq -r '.comment')
  if [ "$PROTO" = "vrrp" ]; then
    ufw allow proto vrrp from any to any comment "$COMMENT" >/dev/null 2>&1 || true
  else
    PORT=$(echo "$rule" | jq -r '.port')
    ufw allow "${PORT}/${PROTO}" comment "$COMMENT" >/dev/null 2>&1 || true
  fi
done

# Postgres peer rules -- the only fully dynamic part. Reconcile exactly
# (add missing, remove stale) rather than just adding, since a node
# leaving the cluster should stop being able to reach 5432 here, not just
# never get re-added if it comes back as something else.
DESIRED_PEERS=$(echo "$RESPONSE" | jq -r '.postgres_peer_ips[]?' 2>/dev/null)
CURRENT_PEERS=$(ufw status | awk '/5432\/tcp/ && !/\(v6\)/ {print $3}' | grep -v '^Anywhere$' || true)

if [ -n "$CURRENT_PEERS" ]; then
  while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    if ! printf '%s\n' "$DESIRED_PEERS" | grep -qx "$ip"; then
      ufw delete allow from "$ip" to any port 5432 proto tcp >/dev/null 2>&1 || true
      logger "ClassGuard firewall-sync: removed stale Postgres peer $ip"
    fi
  done <<< "$CURRENT_PEERS"
fi

if [ -n "$DESIRED_PEERS" ]; then
  while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    if ! printf '%s\n' "$CURRENT_PEERS" | grep -qx "$ip"; then
      ufw allow from "$ip" to any port 5432 proto tcp comment 'Postgres replication' >/dev/null 2>&1 || true
      logger "ClassGuard firewall-sync: added Postgres peer $ip"
    fi
  done <<< "$DESIRED_PEERS"
fi

# Enable last, same lockout-safety order as doing this by hand -- only on
# first run; once active this is a no-op so the watcher's repeated calls
# don't matter. --force skips the interactive y/n prompt, which would
# otherwise hang forever with no TTY attached (cron/systemd context).
if ! ufw status | grep -q "Status: active"; then
  ufw --force enable >/dev/null 2>&1 || true
  logger "ClassGuard firewall-sync: ufw enabled for the first time"
fi

logger "ClassGuard firewall-sync: sync complete (role=$(echo "$RESPONSE" | jq -r '.role'), $(echo "$DESIRED_PEERS" | grep -c . || true) postgres peer(s))"
