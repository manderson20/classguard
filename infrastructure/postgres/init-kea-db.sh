#!/bin/bash
# Runs automatically via /docker-entrypoint-initdb.d/ — but ONLY on a brand
# new, empty postgres data volume (the official image skips this directory
# entirely once PGDATA already has a database). Kea needs its own database,
# separate from the app's "classguard" one, because kea-admin db-init
# requires its target database to be completely empty, and the app's own
# migrations always populate dozens of tables first.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE classguard_kea OWNER $POSTGRES_USER;
EOSQL
