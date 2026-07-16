#!/bin/bash
# Reconciles the Zabbix agent 2 install on this node — same pattern as
# sync-freeradius.sh / sync-keepalived.sh: run every minute by the
# update-watcher (and once during install.sh), no-ops entirely unless an
# admin has set a Zabbix server address (Settings ▸ Monitoring). Because the
# setting replicates cluster-wide, every node — including a fresh install or
# a newly joined HA peer — converges to a configured, running agent without
# anyone logging in and running an installer by hand.
#
# install-zabbix-agent2.sh in this directory remains the manual/standalone
# path (e.g. installing from the official Zabbix repo instead of Ubuntu's).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

RESPONSE=$(curl -sf http://localhost:3001/metrics/zabbix-sync) || exit 0
ENABLED=$(echo "$RESPONSE" | jq -r '.enabled')
if [ "$ENABLED" != "true" ]; then exit 0; fi
ZBX_SERVER=$(echo "$RESPONSE" | jq -r '.server')
ZBX_HOSTNAME=$(echo "$RESPONSE" | jq -r '.hostname')
if [ -z "$ZBX_SERVER" ] || [ "$ZBX_SERVER" = "null" ]; then exit 0; fi

if ! command -v zabbix_agent2 >/dev/null 2>&1; then
  # Ubuntu 24.04 ships no zabbix packages at all — the agent comes from the
  # official repo.zabbix.com 6.0 LTS channel. A 6.0 agent is supported by
  # every Zabbix server >= 6.0, so this can never outrun the site's server
  # version the way a 7.x agent could.
  if ! apt-cache show zabbix-agent2 >/dev/null 2>&1; then
    . /etc/os-release
    RELEASE_DEB="zabbix-release_latest_6.0+ubuntu${VERSION_ID}_all.deb"
    TMP_DEB=$(mktemp --suffix=.deb)
    if curl -fsSL -o "$TMP_DEB" "https://repo.zabbix.com/zabbix/6.0/ubuntu/pool/main/z/zabbix-release/$RELEASE_DEB"; then
      dpkg -i "$TMP_DEB" >/dev/null 2>&1 || true
      logger "ClassGuard zabbix-sync: added repo.zabbix.com 6.0 apt source"
    else
      logger "ClassGuard zabbix-sync: failed to fetch $RELEASE_DEB, will retry next tick"
      rm -f "$TMP_DEB"
      exit 0
    fi
    rm -f "$TMP_DEB"
  fi
  apt-get update -qq || true
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y zabbix-agent2 >/dev/null 2>&1; then
    logger "ClassGuard zabbix-sync: zabbix-agent2 install failed, will retry next tick"
    exit 0
  fi
  logger "ClassGuard zabbix-sync: installed zabbix-agent2"
fi

CHANGED=false

# Group membership the ClassGuard checks need (docker: container discovery +
# the metrics blob via docker exec; adm: journald; freerad: traverse
# /etc/freeradius for the EAP cert expiry check).
GROUPS_WANTED="docker adm"
if getent group freerad >/dev/null 2>&1; then GROUPS_WANTED="$GROUPS_WANTED freerad"; fi
for g in $GROUPS_WANTED; do
  if ! id -nG zabbix 2>/dev/null | grep -qw "$g"; then
    usermod -aG "$g" zabbix
    CHANGED=true
  fi
done

# ClassGuard UserParameters, deployed straight from the repo working tree —
# a git pull that changes them is applied on the next tick.
CONF_SRC="$REPO_DIR/infrastructure/zabbix/zabbix_agent2_classguard.conf"
CONF_DST="/etc/zabbix/zabbix_agent2.d/classguard.conf"
if [ -f "$CONF_SRC" ] && ! diff -q "$CONF_SRC" "$CONF_DST" >/dev/null 2>&1; then
  install -m 644 "$CONF_SRC" "$CONF_DST"
  CHANGED=true
fi

# Server / ServerActive / Hostname in the main agent config.
MAIN_CONF="/etc/zabbix/zabbix_agent2.conf"
ensure_kv() {
  local key="$1" val="$2"
  if grep -q "^${key}=${val}\$" "$MAIN_CONF"; then return 0; fi
  if grep -q "^${key}=" "$MAIN_CONF"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$MAIN_CONF"
  else
    echo "${key}=${val}" >> "$MAIN_CONF"
  fi
  CHANGED=true
}
ensure_kv Server       "$ZBX_SERVER"
ensure_kv ServerActive "$ZBX_SERVER"
ensure_kv Hostname     "$ZBX_HOSTNAME"

systemctl is-enabled --quiet zabbix-agent2 2>/dev/null || systemctl enable zabbix-agent2 >/dev/null 2>&1 || true

if [ "$CHANGED" = "true" ]; then
  systemctl restart zabbix-agent2 || true
  logger "ClassGuard zabbix-sync: applied config (server=$ZBX_SERVER hostname=$ZBX_HOSTNAME), restarted zabbix-agent2"
elif ! systemctl is-active --quiet zabbix-agent2 2>/dev/null; then
  systemctl start zabbix-agent2 || true
  logger "ClassGuard zabbix-sync: started zabbix-agent2 (was not running)"
fi
