#!/bin/sh
# Ensures nginx always has a cert to load (self-signed placeholder until
# Let's Encrypt issues a real one — see backend/src/services/acmeTls.js),
# then watches for the real cert appearing/renewing and reloads nginx
# without a container restart.
set -e

CERT_DIR=/etc/nginx/certs
CERT="$CERT_DIR/fullchain.pem"
KEY="$CERT_DIR/privkey.pem"

mkdir -p "$CERT_DIR"

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "[tls] No certificate yet — generating a self-signed placeholder"
  openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=classguard.local/O=ClassGuard" >/dev/null 2>&1
fi

# Background watcher: reload nginx whenever the cert files change (e.g. after
# the API container issues/renews a Let's Encrypt cert into the shared volume).
# Runs detached — this script is sourced by nginx's own entrypoint, which
# starts nginx itself afterward, so we must not exec/block here.
(
  last=""
  while true; do
    sleep 30
    cur=$(stat -c '%Y' "$CERT" "$KEY" 2>/dev/null | tr '\n' '-')
    if [ -n "$last" ] && [ "$cur" != "$last" ]; then
      echo "[tls] Certificate changed — reloading nginx"
      nginx -s reload 2>/dev/null || true
    fi
    last="$cur"
  done
) &
