#!/bin/bash
# Reconciles this host's chrony install/config with what ntp.js's
# GET /server-sync says it should be right now. Unlike keepalived, chrony
# config is identical on every node (no leader-election/priority concept --
# see services/chrony.js), so this is simpler: same content everywhere,
# nothing to compute per-node. Same idempotent-poll pattern as
# infrastructure/firewall/sync-ufw.sh and infrastructure/keepalived/
# sync-keepalived.sh.
set -uo pipefail

RESPONSE=$(curl -sf http://localhost:3001/api/v1/ntp/server-sync) || exit 0
[ -z "$RESPONSE" ] && exit 0

ENABLED=$(echo "$RESPONSE" | jq -r '.enabled')

CONF_PATH="/etc/chrony/chrony.conf"
[ -f /etc/chrony.conf ] && CONF_PATH="/etc/chrony.conf"

if [ "$ENABLED" != "true" ]; then
  # NTP server feature is off -- don't keep serving time to the LAN if an
  # admin deliberately turned this back off after trying it.
  if systemctl is-active --quiet chrony 2>/dev/null; then
    systemctl disable --now chrony
    logger "ClassGuard chrony-sync: disabled (NTP server feature turned off)"
  fi
  exit 0
fi

if ! command -v chronyd >/dev/null 2>&1; then
  if systemctl is-enabled systemd-timesyncd >/dev/null 2>&1 || systemctl is-active systemd-timesyncd >/dev/null 2>&1; then
    systemctl disable --now systemd-timesyncd
  fi
  apt-get install -y chrony >/dev/null 2>&1 || exit 0
fi

# generateChronyConf() embeds a live "generated on <timestamp>" comment, and
# its comment text can drift between versions without anything functional
# changing -- strip every comment (whole-line or trailing) and collapse
# whitespace before comparing, same reasoning as sync-keepalived.sh, so an
# unchanged config doesn't force a restart (chrony restarting briefly
# interrupts clock sync for anyone polling this node).
NORMALIZE() { sed 's/#.*$//' | sed 's/[[:space:]]\+/ /g' | grep -v '^[[:space:]]*$'; }

NEW_CONF=$(echo "$RESPONSE" | jq -r '.conf')
NEEDS_RESTART=false

if [ ! -f "$CONF_PATH" ] || ! diff -q <(echo "$NEW_CONF" | NORMALIZE) <(NORMALIZE < "$CONF_PATH") >/dev/null 2>&1; then
  echo "$NEW_CONF" > "$CONF_PATH"
  NEEDS_RESTART=true
  logger "ClassGuard chrony-sync: chrony.conf changed"
fi

systemctl is-enabled --quiet chrony 2>/dev/null || systemctl enable chrony >/dev/null 2>&1 || true

if [ "$NEEDS_RESTART" = "true" ]; then
  systemctl restart chrony
  logger "ClassGuard chrony-sync: applied config change, restarted chrony"
elif ! systemctl is-active --quiet chrony 2>/dev/null; then
  systemctl start chrony
  logger "ClassGuard chrony-sync: started chrony (was not running)"
fi

# Client-activity reporter -- cheap and idempotent, refresh every poll
# regardless of whether chrony.conf itself changed.
echo "$RESPONSE" | jq -r '.client_report_sh' > /usr/local/bin/ntp-client-report.sh
chmod +x /usr/local/bin/ntp-client-report.sh
CRON_LINE="*/5 * * * * /usr/local/bin/ntp-client-report.sh"
(crontab -l 2>/dev/null | grep -vF "ntp-client-report.sh"; echo "$CRON_LINE") | crontab -
