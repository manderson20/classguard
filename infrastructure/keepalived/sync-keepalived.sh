#!/bin/bash
# Reconciles this host's keepalived install/config with what ha.js's
# GET /vrrp-sync says it should be right now (this node's own rendered
# keepalived.conf, given its current failover_priority and the cluster's
# VIP settings). Idempotent -- safe to run from install.sh once AND from
# the update-watcher's timer every minute, same pattern as
# infrastructure/firewall/sync-ufw.sh.
#
# Restarting keepalived briefly drops VRRP advertisements -- if this node
# is the current MASTER, that's a short VIP blip to a BACKUP node and back.
# Unavoidable on a real config change (a priority edit would cause the same
# blip done by hand), so the one thing that actually matters here is never
# restarting on a NO-OP poll -- see NORMALIZE below.
set -uo pipefail

RESPONSE=$(curl -sf http://localhost:3001/api/v1/ha/vrrp-sync) || exit 0
[ -z "$RESPONSE" ] && exit 0

ENABLED=$(echo "$RESPONSE" | jq -r '.enabled')
CONF_PATH="/etc/keepalived/keepalived.conf"
NOTIFY_PATH="/etc/keepalived/notify.sh"

if [ "$ENABLED" != "true" ]; then
  # No VIP configured -- a single-node install was never meant to run this.
  # If it's active anyway (VIP unconfigured after being set up), stop it.
  if systemctl is-active --quiet keepalived 2>/dev/null; then
    systemctl disable --now keepalived
    logger "ClassGuard keepalived-sync: disabled (no VIP configured)"
  fi
  exit 0
fi

if ! command -v keepalived >/dev/null 2>&1; then
  apt-get install -y keepalived >/dev/null 2>&1 || exit 0
fi

mkdir -p /etc/keepalived

# generateKeepalived() embeds a literal "generated on <live timestamp>"
# comment that differs every call, and its comment text/formatting can
# legitimately drift between ClassGuard versions without anything
# *functional* (priority, VIP, auth_pass, etc.) actually changing. Strip
# every comment (whole-line or trailing) and collapse whitespace before
# comparing -- restarting keepalived on a cosmetic-only diff would risk an
# unwanted VRRP role flip if this node is the current MASTER (a brief
# advertisement gap can let a BACKUP node grab MASTER, and `nopreempt`
# means this node won't automatically reclaim it afterward).
NORMALIZE() { sed 's/#.*$//' | sed 's/[[:space:]]\+/ /g' | grep -v '^[[:space:]]*$'; }

NEW_CONF=$(echo "$RESPONSE" | jq -r '.conf')
NEEDS_RESTART=false

if [ ! -f "$CONF_PATH" ] || ! diff -q <(echo "$NEW_CONF" | NORMALIZE) <(NORMALIZE < "$CONF_PATH") >/dev/null 2>&1; then
  echo "$NEW_CONF" > "$CONF_PATH"
  NEEDS_RESTART=true
  logger "ClassGuard keepalived-sync: keepalived.conf changed"
fi

NEW_NOTIFY=$(echo "$RESPONSE" | jq -r '.notify')
if [ ! -f "$NOTIFY_PATH" ] || ! diff -q <(echo "$NEW_NOTIFY" | NORMALIZE) <(NORMALIZE < "$NOTIFY_PATH") >/dev/null 2>&1; then
  echo "$NEW_NOTIFY" > "$NOTIFY_PATH"
  chmod +x "$NOTIFY_PATH"
  NEEDS_RESTART=true
fi

systemctl is-enabled --quiet keepalived 2>/dev/null || systemctl enable keepalived >/dev/null 2>&1 || true

if [ "$NEEDS_RESTART" = "true" ]; then
  systemctl restart keepalived
  logger "ClassGuard keepalived-sync: applied config change, restarted keepalived"
elif ! systemctl is-active --quiet keepalived 2>/dev/null; then
  systemctl start keepalived
  logger "ClassGuard keepalived-sync: started keepalived (was not running)"
fi
