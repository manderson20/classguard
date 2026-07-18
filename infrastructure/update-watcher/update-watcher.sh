#!/bin/bash
# Polls this node's own API for a pending scheduled update; once its
# scheduled time arrives, runs install.sh (pull + rebuild + restart) and
# reports the result back. Installed as a systemd timer by install.sh —
# see infrastructure/update-watcher/*.service|.timer.
#
# Talks only to localhost:3001 — same trust boundary as keepalived's own
# health-check script. The API relays to the primary itself if this node
# is a standby (update_schedule only lives on the primary's writable DB).
set -euo pipefail

REPO_DIR="/opt/classguard"
cd "$REPO_DIR"

# --- Promotion check (standby -> primary) -----------------------------
# config.node.role is read from NODE_ROLE at process startup, so a Postgres
# promotion (POST /ha/promote) alone isn't enough — this node's .env and
# container set need updating too (Kea included; it was deliberately never
# started on a standby). Checked every tick alongside the update check
# below, same trust boundary (localhost only).
PROMOTE_PENDING=$(curl -sf http://localhost:3001/api/v1/ha/promote-status | jq -r '.pending') || PROMOTE_PENDING=false
if [ "$PROMOTE_PENDING" = "true" ]; then
  logger "ClassGuard update-watcher: promotion to primary requested, updating .env and restarting"
  if grep -q '^NODE_ROLE=' .env; then
    sed -i 's/^NODE_ROLE=.*/NODE_ROLE=primary/' .env
  else
    echo 'NODE_ROLE=primary' >> .env
  fi
  if grep -q '^RUN_CRON_JOBS=' .env; then
    sed -i 's/^RUN_CRON_JOBS=.*/RUN_CRON_JOBS=true/' .env
  else
    echo 'RUN_CRON_JOBS=true' >> .env
  fi
  docker compose up -d
  curl -sf -X POST http://localhost:3001/api/v1/ha/promote-complete || true
  logger "ClassGuard update-watcher: promotion complete"
fi

# --- Firewall sync ------------------------------------------------------
# Keeps ufw in sync with this node's current role + cluster membership
# every tick — a new node joining (or one leaving) changes the desired
# Postgres peer-allow list without anyone having to log into this host and
# run anything by hand. See infrastructure/firewall/sync-ufw.sh.
bash "$REPO_DIR/infrastructure/firewall/sync-ufw.sh" || true

# --- VRRP / keepalived sync ----------------------------------------------
# Same idea, for keepalived -- a priority change or a node joining/leaving
# updates this node's own rendered keepalived.conf automatically. No-ops
# entirely if no VIP is configured (single-node install). See
# infrastructure/keepalived/sync-keepalived.sh.
bash "$REPO_DIR/infrastructure/keepalived/sync-keepalived.sh" || true

# --- NTP server (chrony) sync --------------------------------------------
# Same idea again, for the opt-in NTP server feature. No-ops entirely unless
# an admin has turned it on (NTP page → Server). See
# infrastructure/chrony/sync-chrony.sh.
bash "$REPO_DIR/infrastructure/chrony/sync-chrony.sh" || true

# --- FreeRADIUS sync ------------------------------------------------------
# Same idea again, for FreeRADIUS itself -- no-ops entirely unless
# track_freeradius is turned on (RADIUS page → HA & Config). See
# infrastructure/freeradius/sync-freeradius.sh.
bash "$REPO_DIR/infrastructure/freeradius/sync-freeradius.sh" || true

# --- Zabbix agent sync -----------------------------------------------------
# Same idea again, for monitoring -- no-ops entirely unless an admin has set
# a Zabbix server address (Integrations → Zabbix). See
# infrastructure/zabbix/sync-zabbix-agent.sh.
bash "$REPO_DIR/infrastructure/zabbix/sync-zabbix-agent.sh" || true

RESPONSE=$(curl -sf http://localhost:3001/api/v1/ha/update-status) || exit 0
PENDING=$(echo "$RESPONSE" | jq -r '.pending')
[ "$PENDING" = "null" ] && exit 0

STATUS=$(echo "$RESPONSE" | jq -r '.pending.status')
SCHEDULED_AT=$(echo "$RESPONSE" | jq -r '.pending.scheduled_at')

# 'pending'     — a fresh update; run it once its scheduled time arrives.
# 'in_progress' — a PRIOR run set this then died before reporting (build
#                 SIGKILLed, Postgres recreate wedged, host rebooted, ...).
#                 This unit is Type=oneshot with OnUnitActiveSec, so systemd
#                 can't have another run active right now — an in_progress
#                 seen at the top of a fresh tick is a crashed run to recover,
#                 not a live one. Re-running install.sh is safe: it reconciles
#                 containers (docker compose up -d) and re-verifies Postgres.
#                 Without this, a crashed run left the row stuck at
#                 in_progress forever, blocking every future update.
# other         — completed/failed: nothing to do.
case "$STATUS" in
  pending)
    SCHEDULED_EPOCH=$(date -d "$SCHEDULED_AT" +%s 2>/dev/null) || exit 0
    NOW_EPOCH=$(date +%s)
    [ "$NOW_EPOCH" -lt "$SCHEDULED_EPOCH" ] && exit 0
    logger "ClassGuard update-watcher: scheduled update time reached, starting"
    ;;
  in_progress)
    logger "ClassGuard update-watcher: found a crashed in-progress update — recovering"
    ;;
  *)
    exit 0
    ;;
esac

curl -sf -X POST http://localhost:3001/api/v1/ha/update-complete \
  -H "Content-Type: application/json" -d '{"status":"in_progress"}' || true

LOG_FILE=$(mktemp)
if bash install.sh > "$LOG_FILE" 2>&1; then
  FINAL_STATUS=completed
  logger "ClassGuard update-watcher: update completed successfully"
else
  FINAL_STATUS=failed
  logger "ClassGuard update-watcher: update FAILED — check $LOG_FILE"
fi

LOG_JSON=$(jq -Rs --arg status "$FINAL_STATUS" '{status: $status, log: .}' < <(tail -c 4000 "$LOG_FILE"))
# Retry the completion report for up to ~2 minutes: install.sh has just
# swapped the containers, so the API is often still starting when the first
# POST fires — a single silently-swallowed failure here left the schedule
# row wedged at in_progress (blocking every future update for this node)
# even though the update itself succeeded. Observed twice in production
# before this retry existed.
for _ in $(seq 1 24); do
  if curl -sf -X POST http://localhost:3001/api/v1/ha/update-complete \
    -H "Content-Type: application/json" -d "$LOG_JSON" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

if [ "$FINAL_STATUS" = "failed" ]; then
  # Keep the FULL log on disk for a failed run. In practice these have all
  # been well under the 4000-byte cap sent to the DB above (see install.sh's
  # `timeout`-wrapped Step 6 commands — a hang now fails loudly with its own
  # marker instead of silently eating minutes with zero output), but keep
  # this as a hedge for any future run whose real output exceeds that. /var/log
  # survives reboots (/tmp may not, depending on the distro's tmp-on-tmpfs setup).
  FAIL_LOG_DIR="/var/log/classguard-updates"
  mkdir -p "$FAIL_LOG_DIR"
  cp "$LOG_FILE" "$FAIL_LOG_DIR/update-failed-$(date -u +%Y%m%dT%H%M%SZ).log"
  # Retention: keep only the 20 most recent failure logs.
  ls -1t "$FAIL_LOG_DIR"/update-failed-*.log 2>/dev/null | tail -n +21 | xargs -r rm -f
fi
rm -f "$LOG_FILE"
