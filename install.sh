#!/usr/bin/env bash
# =============================================================================
# ClassGuard Install Script
# Tested on: Ubuntu 22.04 / 24.04 LTS
# Run as root or with sudo: sudo bash install.sh
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
section() { echo -e "\n${GREEN}══════════════════════════════════════${NC}"; echo -e "${GREEN} $*${NC}"; echo -e "${GREEN}══════════════════════════════════════${NC}"; }

# ---------------------------------------------------------------------------
# Must run as root
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  error "Please run as root: sudo bash install.sh"
fi

section "ClassGuard Install"
info "Working directory: $REPO_DIR"

# ---------------------------------------------------------------------------
# 0. Pull latest code — makes this script double as the update path too:
# re-running it on an existing install is the only thing needed to pick up
# new commits, no separate manual git pull/build/restart steps.
# Skipped (with a warning) if there are uncommitted local changes, so this
# never silently clobbers something an admin was editing by hand.
# ---------------------------------------------------------------------------
cd "$REPO_DIR"
if [[ -d .git ]]; then
  # This script always runs as root, but the repo is typically checked out
  # by whichever user cloned it — git refuses to touch a repo it doesn't
  # "own" unless that path is explicitly trusted, so grant it here rather
  # than make every admin hit this the first time the watcher (or they)
  # re-run install.sh as root. --system (not --global) since systemd's
  # update-watcher service runs root with no $HOME set, so a --global
  # write to ~/.gitconfig would be unreadable to git anyway.
  git config --system --add safe.directory "$REPO_DIR"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    warn "Uncommitted local changes in $REPO_DIR — skipping git pull. Commit/stash them and re-run to update."
  else
    section "Step 0 — Pull latest"
    BEFORE_REV=$(git rev-parse HEAD)
    git pull --ff-only
    AFTER_REV=$(git rev-parse HEAD)
    if [[ "$BEFORE_REV" == "$AFTER_REV" ]]; then
      info "Already up to date ($AFTER_REV)"
    else
      info "Updated $BEFORE_REV -> $AFTER_REV"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
section "Step 1 — System packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release openssl iproute2 jq

# ---------------------------------------------------------------------------
# 2. Docker Engine + Compose plugin
# ---------------------------------------------------------------------------
section "Step 2 — Docker Engine"

if command -v docker &>/dev/null; then
  info "Docker already installed: $(docker --version)"
else
  info "Installing Docker..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  systemctl enable docker
  systemctl start docker
  info "Docker installed: $(docker --version)"
fi

# Verify compose plugin
if ! docker compose version &>/dev/null; then
  error "Docker Compose plugin not found. Install with: apt-get install docker-compose-plugin"
fi
info "Docker Compose: $(docker compose version)"

# ---------------------------------------------------------------------------
# 3. Add current SUDO_USER to docker group (so they can run docker without sudo)
# ---------------------------------------------------------------------------
section "Step 3 — Docker group"
REAL_USER="${SUDO_USER:-}"
if [[ -n "$REAL_USER" ]]; then
  usermod -aG docker "$REAL_USER"
  info "Added $REAL_USER to docker group (re-login to take effect)"
fi

# ---------------------------------------------------------------------------
# 4. Environment file
# ---------------------------------------------------------------------------
section "Step 4 — Environment (.env)"
cd "$REPO_DIR"

if [[ -f .env ]]; then
  info ".env already exists — skipping generation"
else
  info "No .env found — generating from template..."

  # Detect primary non-loopback IP. The `|| true` matters: under
  # set -euo pipefail, any failure in this pipeline (no default route yet,
  # `ip` missing, etc.) would otherwise kill the whole script right here,
  # before ever reaching the 127.0.0.1 fallback on the next line.
  SERVER_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1) || true
  SERVER_IP="${SERVER_IP:-127.0.0.1}"
  info "Detected server IP: $SERVER_IP"

  DB_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
  JWT_SEC=$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 64)
  INT_SEC=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)

  cat > .env <<EOF
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Edit this file to configure ClassGuard.

NODE_ENV=production
PORT=3001
APP_URL=http://${SERVER_IP}
FRONTEND_URL=http://${SERVER_IP}

# Database
DB_PASSWORD=${DB_PASS}
DATABASE_URL=postgresql://classguard:${DB_PASS}@postgres:5432/classguard

# Redis
REDIS_URL=redis://redis:6379

# JWT
JWT_SECRET=${JWT_SEC}
JWT_EXPIRES_IN=8h

# Internal API secret (DNS engine → API)
INTERNAL_SECRET=${INT_SEC}

# Host/IP this server answers on — admin UI (frontend) and the DNS listener
# both bind here. Detected automatically above; if this box has multiple
# NICs and picked the wrong one, edit both lines and re-run
# "docker compose up -d frontend dns".
CLASSGUARD_HOST=${SERVER_IP}
DNS_BIND_IP=${SERVER_IP}

# DNS engine
DNS_UPSTREAM_PRIMARY=1.1.1.1
DNS_UPSTREAM_SECONDARY=8.8.8.8
DNS_BLOCK_PAGE_IP=${SERVER_IP}
BACKEND_URL=http://api:3001

# Kea DHCP
KEA_CONTROL_AGENT_URL=http://kea:8000

# HA / multi-node
NODE_ID=node1
NODE_ROLE=primary
RUN_CRON_JOBS=true

# Google Workspace (configure via Settings page after first login)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REDIRECT_URI=http://${SERVER_IP}/api/v1/auth/google/callback
# GOOGLE_WORKSPACE_DOMAIN=
# GOOGLE_SERVICE_ACCOUNT_KEY_PATH=
# SUPERADMIN_EMAIL=
EOF

  chmod 600 .env
  info ".env created with auto-generated secrets"
  warn "DB password and JWT secret are stored in .env — keep this file private"
fi

# Source DB_PASSWORD for use below
DB_PASSWORD=$(grep '^DB_PASSWORD=' .env | cut -d= -f2-)

# ---------------------------------------------------------------------------
# 5. Build and start the stack
# ---------------------------------------------------------------------------
section "Step 5 — Build containers"
info "Building all containers (this takes a few minutes on first run)..."
docker compose build --parallel

section "Step 6 — Start services"
info "Starting postgres and redis first..."
docker compose up -d postgres redis

# On a brand new volume, TimescaleDB auto-tunes itself and restarts once
# during its very first init (separate from our own db-init script) — a
# bare `pg_isready` can catch it ready during that restart's brief window
# and falsely report success right before it bounces. `--wait` polls the
# real Compose healthcheck (which needs several consecutive successful
# checks, not just one) so it rides out that blip correctly.
info "Waiting for postgres to be healthy..."
if ! docker compose up -d --wait postgres redis; then
  error "PostgreSQL/Redis did not become healthy in time — check: docker compose logs postgres"
fi
info "PostgreSQL is ready"

info "Running database migrations..."
docker compose run --rm migrate

info "Starting remaining services..."
# A standby's Postgres (and Kea's own database, replicated along with it) is
# read-only, so Kea would just crash-loop trying to write leases there —
# only bring up the services that are actually safe/useful on a standby.
NODE_ROLE_CURRENT=$(grep '^NODE_ROLE=' .env | cut -d= -f2-)
if [[ "$NODE_ROLE_CURRENT" == "standby" ]]; then
  info "NODE_ROLE=standby — starting redis/api/dns/frontend only (skipping kea)"
  docker compose up -d redis api dns frontend
else
  docker compose up -d
fi

# ---------------------------------------------------------------------------
# 6. Wait for API to be healthy
# ---------------------------------------------------------------------------
section "Step 7 — Health check"
info "Waiting for API to be healthy..."
for i in $(seq 1 40); do
  if docker compose exec -T api wget -qO- http://localhost:3001/health &>/dev/null 2>&1; then
    info "API is healthy"
    break
  fi
  if [[ $i -eq 40 ]]; then
    warn "API health check timed out — check logs with: docker compose logs api"
    break
  fi
  sleep 3
done

SERVER_IP=$(grep '^APP_URL=' .env | cut -d= -f2- | sed 's|http://||;s|https://||' | cut -d/ -f1) || true
SERVER_IP="${SERVER_IP:-this-server}"

# ---------------------------------------------------------------------------
# 8. Firewall — installs ufw + fail2ban if missing and brings ufw to the
# correct rule set for whichever role this node has (see GET
# /ha/firewall-rules and infrastructure/firewall/sync-ufw.sh). Runs again
# every minute via the update-watcher below, so a node that later joins or
# leaves the cluster keeps the Postgres peer-allow list current without
# anyone re-running install.sh by hand.
# ---------------------------------------------------------------------------
section "Step 8 — Firewall"
bash "$REPO_DIR/infrastructure/firewall/sync-ufw.sh" || warn "Firewall sync failed — check manually with: ufw status verbose"
info "ufw + fail2ban configured for this node's role"

# ---------------------------------------------------------------------------
# 8b/8c. VRRP (keepalived) and NTP server (chrony) — both no-op entirely
# unless an admin has actually configured a VIP / turned the NTP server
# feature on, same opt-in reasoning as the firewall step above. Re-run
# every minute by the update-watcher so cluster/config changes propagate
# without anyone re-running install.sh by hand.
# ---------------------------------------------------------------------------
section "Step 8b — VRRP / keepalived"
bash "$REPO_DIR/infrastructure/keepalived/sync-keepalived.sh" || warn "keepalived sync failed — check manually with: systemctl status keepalived"

section "Step 8c — NTP server (chrony)"
bash "$REPO_DIR/infrastructure/chrony/sync-chrony.sh" || warn "chrony sync failed — check manually with: systemctl status chrony"

# ---------------------------------------------------------------------------
# 9. Scheduled-update watcher — installed once, idempotent on re-run.
# Polls this node's own API every minute for an admin-scheduled update
# (HA page → Software Updates) and runs this exact install.sh again once
# the scheduled time arrives, so a maintenance window can be picked in the
# UI instead of someone having to be on a terminal at a specific time.
# ---------------------------------------------------------------------------
section "Step 9 — Scheduled-update watcher"
cp "$REPO_DIR/infrastructure/update-watcher/classguard-update-watcher.service" /etc/systemd/system/
cp "$REPO_DIR/infrastructure/update-watcher/classguard-update-watcher.timer"   /etc/systemd/system/
chmod +x "$REPO_DIR/infrastructure/update-watcher/update-watcher.sh"
systemctl daemon-reload
systemctl enable --now classguard-update-watcher.timer
info "Update watcher installed — checks every minute for an admin-scheduled update"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
section "ClassGuard is running!"
echo ""
echo -e "  Web interface:  ${GREEN}http://${SERVER_IP}${NC}"
echo -e "  API health:     ${GREEN}http://${SERVER_IP}/api/v1/auth/setup-status${NC}"
echo ""
echo "  First login:"
echo "  → Open http://${SERVER_IP} in your browser"
echo "  → You will be redirected to the setup wizard to create your admin account"
echo ""
echo "  Useful commands:"
echo "    docker compose ps                  # check container status"
echo "    docker compose logs -f api         # stream API logs"
echo "    docker compose logs -f frontend    # stream frontend logs"
echo "    docker compose down                # stop everything"
echo "    docker compose up -d               # start everything"
echo "    docker compose run --rm migrate    # re-run migrations"
echo ""
echo "  DNS filtering:"
echo "    Point your DHCP server's DNS option to $(grep '^DNS_BLOCK_PAGE_IP=' .env | cut -d= -f2-) (this server)"
echo ""
