#!/bin/bash
# Reconciles this host's FreeRADIUS install/config with what radius.js's
# GET /freeradius-sync says it should be right now. Same idempotent-poll
# pattern as infrastructure/{firewall,keepalived,chrony}/sync-*.sh -- safe
# to run from install.sh once AND from the update-watcher's timer every
# minute. Runs on every node (not just the primary) -- the VIP can float to
# whichever node is currently MASTER, so FreeRADIUS needs to already be
# running there, not started on demand during a failover.
#
# Gated on the SAME track_freeradius flag keepalived's own check_freeradius
# script and /ha/firewall-rules use -- see
# project_state_vrrp_nopreempt_incident.md for why this flag actually
# matters beyond cosmetics: a stale "tracked but not deployed" state
# silently skews VRRP election priority.
set -uo pipefail

RESPONSE=$(curl -sf http://localhost:3001/api/v1/radius/freeradius-sync) || exit 0
[ -z "$RESPONSE" ] && exit 0

ENABLED=$(echo "$RESPONSE" | jq -r '.enabled')
FR_DIR="/etc/freeradius/3.0"

if [ "$ENABLED" != "true" ]; then
  if systemctl is-active --quiet freeradius 2>/dev/null; then
    systemctl disable --now freeradius
    logger "ClassGuard freeradius-sync: disabled (track_freeradius turned off)"
  fi
  exit 0
fi

if ! command -v freeradius >/dev/null 2>&1 && ! command -v radiusd >/dev/null 2>&1; then
  apt-get update -qq || true
  apt-get install -y freeradius freeradius-rest >/dev/null 2>&1 || exit 0
fi

[ -d "$FR_DIR" ] || exit 0

# Same comment/whitespace-stripping reasoning as sync-keepalived.sh and
# sync-chrony.sh -- none of these files embed a live timestamp today, but
# strip comments anyway so a future cosmetic-only regen never forces an
# unwanted restart (a FreeRADIUS restart drops in-flight auth sessions).
NORMALIZE() { sed 's/#.*$//' | sed 's/[[:space:]]\+/ /g' | grep -v '^[[:space:]]*$'; }

NEEDS_RESTART=false

sync_file() {
  local key="$1" path="$2" mode="${3:-644}"
  local new_content
  new_content=$(echo "$RESPONSE" | jq -r ".$key")
  if [ ! -f "$path" ] || ! diff -q <(echo "$new_content" | NORMALIZE) <(NORMALIZE < "$path") >/dev/null 2>&1; then
    echo "$new_content" > "$path"
    chmod "$mode" "$path"
    NEEDS_RESTART=true
    logger "ClassGuard freeradius-sync: $(basename "$path") changed"
  fi
}

sync_file clients_conf    "$FR_DIR/clients.conf"
sync_file rest_conf       "$FR_DIR/mods-available/rest"
sync_file eap_conf        "$FR_DIR/mods-available/eap"
sync_file classguard_conf "$FR_DIR/sites-available/classguard"

# Structural enable/disable -- idempotent, cheap to re-check every poll
# rather than only on first install.
ln -sf "$FR_DIR/mods-available/rest" "$FR_DIR/mods-enabled/rest"
ln -sf "$FR_DIR/sites-available/classguard" "$FR_DIR/sites-enabled/classguard"
rm -f "$FR_DIR/sites-enabled/default" "$FR_DIR/sites-enabled/inner-tunnel"

# EAP TLS material -- generate once, never regenerate (a rotating server
# cert would invalidate any already-trusted device profile for no reason).
mkdir -p "$FR_DIR/certs"
if [ ! -f "$FR_DIR/certs/server.crt" ]; then
  openssl req -x509 -newkey rsa:4096 \
    -keyout "$FR_DIR/certs/server.key" \
    -out    "$FR_DIR/certs/server.crt" \
    -days   3650 -nodes \
    -subj   "/CN=ClassGuard RADIUS/O=School District" 2>/dev/null
  openssl dhparam -out "$FR_DIR/certs/dh" 2048 2>/dev/null
  cp "$FR_DIR/certs/server.crt" "$FR_DIR/certs/ca.crt"
  chmod 640 "$FR_DIR/certs/server.key"
  chown root:freerad "$FR_DIR/certs/server.key" 2>/dev/null || true
  NEEDS_RESTART=true
  logger "ClassGuard freeradius-sync: generated EAP TLS certificate"
fi

# The API's authorize/authenticate responses reference control:ClassGuard-VLAN,
# which must exist in a dictionary or rlm_rest can't map the returned JSON.
# 3000-3999 is the range FreeRADIUS reserves for site-local internal attributes.
if ! grep -q "^ATTRIBUTE[[:space:]]\+ClassGuard-VLAN[[:space:]]" "$FR_DIR/dictionary" 2>/dev/null; then
  printf 'ATTRIBUTE\tClassGuard-VLAN\t\t3900\tstring\n' >> "$FR_DIR/dictionary"
  NEEDS_RESTART=true
  logger "ClassGuard freeradius-sync: added ClassGuard-VLAN to local dictionary"
fi

systemctl is-enabled --quiet freeradius 2>/dev/null || systemctl enable freeradius >/dev/null 2>&1 || true

if [ "$NEEDS_RESTART" = "true" ]; then
  systemctl restart freeradius
  logger "ClassGuard freeradius-sync: applied config change, restarted freeradius"
elif ! systemctl is-active --quiet freeradius 2>/dev/null; then
  systemctl start freeradius
  logger "ClassGuard freeradius-sync: started freeradius (was not running)"
fi
