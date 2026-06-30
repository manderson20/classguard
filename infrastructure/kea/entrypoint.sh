#!/bin/bash
set -e

# The mounted config files are read-only and contain a literal "${DB_PASSWORD}"
# placeholder (Kea does not do env-var substitution itself) — render real
# copies into a writable directory before launching either daemon.
mkdir -p /tmp/kea-conf
envsubst '${DB_PASSWORD}' < /etc/kea/kea-dhcp4.conf      > /tmp/kea-conf/kea-dhcp4.conf
envsubst '${DB_PASSWORD}' < /etc/kea/kea-dhcp6.conf      > /tmp/kea-conf/kea-dhcp6.conf
envsubst '${DB_PASSWORD}' < /etc/kea/kea-ctrl-agent.conf > /tmp/kea-conf/kea-ctrl-agent.conf

# Clear stale PID/socket files left behind by a previous crashed run. Kea 3.x
# validates that the control-socket directory is under /run/kea and is not more
# permissive than 0750. The Ubuntu packages run Kea as _kea, so create the
# runtime, log, and state directories explicitly for container usage.
mkdir -p /run/kea /var/log/kea /var/lib/kea
chown -R _kea:_kea /run/kea /var/log/kea /var/lib/kea
chmod 750 /run/kea
rm -f /run/kea/*.pid /run/kea/*.sock

# Initialize or upgrade Kea schema in PostgreSQL.
# Kea gets its own dedicated database (classguard_kea, created by postgres's
# init script — see infrastructure/postgres/init-kea-db.sh) rather than
# sharing the app's "classguard" database: kea-admin db-init requires an
# EMPTY database to run, and the app's migrations always populate dozens of
# tables before Kea ever starts, so db-init would abort every time and Kea
# would never get its lease tables created.
kea_db_args=(
  pgsql
  -u classguard
  -p "${DB_PASSWORD}"
  -n classguard_kea
  -h postgres
)

kea_schema_exists="$(
  PGPASSWORD="${DB_PASSWORD}" psql \
    -h postgres \
    -U classguard \
    -d classguard_kea \
    -tAc "SELECT to_regclass('public.schema_version') IS NOT NULL" 2>/dev/null || true
)"

if [ "${kea_schema_exists}" = "t" ]; then
  # Existing installs may have a Kea 2.x lease schema. Upgrade it in place when
  # Kea ships a newer PostgreSQL schema. Failure is tolerated here; daemon
  # startup below still verifies database compatibility and logs the real error.
  kea-admin db-upgrade "${kea_db_args[@]}" >/dev/null 2>&1 || true
else
  kea-admin db-init "${kea_db_args[@]}" >/dev/null 2>&1 || true
fi

# Start Kea Control Agent in the background
kea-ctrl-agent -c /tmp/kea-conf/kea-ctrl-agent.conf &

# Start Kea DHCPv6 in the background
kea-dhcp6 -c /tmp/kea-conf/kea-dhcp6.conf &

# Start Kea DHCP4 in the foreground (PID 1)
exec kea-dhcp4 -c /tmp/kea-conf/kea-dhcp4.conf
