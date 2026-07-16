#!/bin/bash
# Install and configure Zabbix agent 2 for a ClassGuard node.
#
# Usage (as root, on each cluster node):
#   ./install-zabbix-agent2.sh --server <zabbix-server-ip> [--hostname <name>] [--official-repo]
#
#   --server         IP/DNS of your Zabbix server (Server= and ServerActive=)
#   --hostname       Hostname= the agent reports; must match the host name you
#                    create in Zabbix. Defaults to this machine's hostname.
#   --official-repo  Add repo.zabbix.com and install agent 7.0 LTS from there
#                    instead of Ubuntu's packaged 6.0 agent. Use this if your
#                    Zabbix server is 7.x and you want a matching agent; a 6.0
#                    agent works fine against any 6.0+ server either way.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZBX_SERVER=""
ZBX_HOSTNAME="$(hostname)"
OFFICIAL_REPO=0

while [ $# -gt 0 ]; do
  case "$1" in
    --server)        ZBX_SERVER="$2"; shift 2 ;;
    --hostname)      ZBX_HOSTNAME="$2"; shift 2 ;;
    --official-repo) OFFICIAL_REPO=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$ZBX_SERVER" ]; then
  echo "Usage: $0 --server <zabbix-server-ip> [--hostname <name>] [--official-repo]" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo $0 ...)" >&2
  exit 1
fi

echo "==> Installing zabbix-agent2"
if [ "$OFFICIAL_REPO" -eq 1 ]; then
  . /etc/os-release
  DEB="zabbix-release_latest_7.0+ubuntu${VERSION_ID}_all.deb"
  curl -fsSL -o "/tmp/$DEB" "https://repo.zabbix.com/zabbix/7.0/ubuntu/pool/main/z/zabbix-release/$DEB"
  dpkg -i "/tmp/$DEB"
  rm -f "/tmp/$DEB"
fi
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y zabbix-agent2

echo "==> Granting the zabbix user the groups the ClassGuard checks need"
usermod -aG docker zabbix                    # docker plugin + classguard.api.metrics
usermod -aG adm zabbix                       # journald/syslog readability
getent group freerad >/dev/null && usermod -aG freerad zabbix  # EAP cert expiry check

echo "==> Installing ClassGuard UserParameters"
install -m 644 "$SCRIPT_DIR/zabbix_agent2_classguard.conf" /etc/zabbix/zabbix_agent2.d/classguard.conf

echo "==> Pointing the agent at $ZBX_SERVER as $ZBX_HOSTNAME"
sed -i \
  -e "s|^Server=.*|Server=$ZBX_SERVER|" \
  -e "s|^ServerActive=.*|ServerActive=$ZBX_SERVER|" \
  -e "s|^Hostname=.*|Hostname=$ZBX_HOSTNAME|" \
  -e "s|^# Hostname=$|Hostname=$ZBX_HOSTNAME|" \
  /etc/zabbix/zabbix_agent2.conf
grep -q "^Hostname=" /etc/zabbix/zabbix_agent2.conf || echo "Hostname=$ZBX_HOSTNAME" >> /etc/zabbix/zabbix_agent2.conf

systemctl enable --now zabbix-agent2
systemctl restart zabbix-agent2   # pick up group membership + conf

echo "==> Self-test"
sleep 2
for key in \
  'classguard.api.metrics' \
  'classguard.eap.cert.days' \
  'classguard.update.failed.count' \
  'systemd.unit.info["freeradius.service",ActiveState]' \
  'docker.info'
do
  printf '%-55s ' "$key"
  # -t evaluates the key exactly as the running agent would
  zabbix_agent2 -t "$key" 2>/dev/null | sed 's/^.*|//' | head -c 120
  echo
done

cat <<EOF

Done. Next steps on the Zabbix server:
  1. Import infrastructure/zabbix/templates/classguard_node_by_agent2.yaml
  2. Create a host named exactly "$ZBX_HOSTNAME" with an agent interface
     pointing at this node's real IP (not the VIP), and link the template.
  3. Set the {\$CLASSGUARD.VIP} macro on the host (or template) to your VIP.
See infrastructure/zabbix/README.md for the full guide.
EOF
