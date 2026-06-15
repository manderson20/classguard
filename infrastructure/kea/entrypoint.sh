#!/bin/bash
set -e

# Initialize Kea schema in PostgreSQL (idempotent — safe to re-run)
kea-admin db-init pgsql \
  -u classguard \
  -p "${DB_PASSWORD}" \
  -n classguard \
  -h postgres 2>/dev/null || true

# Start Kea Control Agent in the background
kea-ctrl-agent -c /etc/kea/kea-ctrl-agent.conf &

# Start Kea DHCP4 in the foreground (PID 1)
exec kea-dhcp4 -c /etc/kea/kea-dhcp4.conf
