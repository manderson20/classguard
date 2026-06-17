#!/bin/bash
set -e

# The mounted config files are read-only and contain a literal "${DB_PASSWORD}"
# placeholder (Kea does not do env-var substitution itself) — render real
# copies into a writable directory before launching either daemon.
mkdir -p /tmp/kea-conf
envsubst '${DB_PASSWORD}' < /etc/kea/kea-dhcp4.conf      > /tmp/kea-conf/kea-dhcp4.conf
envsubst '${DB_PASSWORD}' < /etc/kea/kea-ctrl-agent.conf > /tmp/kea-conf/kea-ctrl-agent.conf

# Clear stale PID/socket files left behind by a previous crashed run —
# the container's writable layer persists across restarts (not recreates).
mkdir -p /var/run/kea
rm -f /var/run/kea/*.pid /var/run/kea/*.sock

# Initialize Kea schema in PostgreSQL (idempotent — safe to re-run)
kea-admin db-init pgsql \
  -u classguard \
  -p "${DB_PASSWORD}" \
  -n classguard \
  -h postgres 2>/dev/null || true

# Start Kea Control Agent in the background
kea-ctrl-agent -c /tmp/kea-conf/kea-ctrl-agent.conf &

# Start Kea DHCP4 in the foreground (PID 1)
exec kea-dhcp4 -c /tmp/kea-conf/kea-dhcp4.conf
