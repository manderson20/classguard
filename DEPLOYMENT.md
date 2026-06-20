# ClassGuard — Deployment Guide

This guide covers a single-server production deployment on a brand-new
Ubuntu 22.04/24.04 box, running ClassGuard via Docker Compose (the only
supported deployment method — there is no bare-metal/PM2 path).

Every command below is copy-paste ready. Replace `YOUR_SERVER_IP` and
`classguard.yourdomain.org` with your own values where shown.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Server setup](#2-server-setup)
3. [DNS setup — on-network filtering](#3-dns-setup--on-network-filtering)
4. [Off-network filtering — pushing the DoH profile via MDM](#4-off-network-filtering--pushing-the-doh-profile-via-mdm)
5. [Google Admin — service account and domain-wide delegation](#5-google-admin--service-account-and-domain-wide-delegation)
6. [Google Admin — force-installing the Chrome extension](#6-google-admin--force-installing-the-chrome-extension)
7. [TLS certificate — Let's Encrypt via DNS-01](#7-tls-certificate--lets-encrypt-via-dns-01)
8. [Database backups](#8-database-backups)

---

## 1. Prerequisites

| Requirement | Minimum |
|-------------|---------|
| OS          | Ubuntu 22.04 or 24.04 LTS, nothing else installed |
| RAM         | 4 GB |
| Disk        | 40 GB SSD |
| Network     | A static LAN IP for this server |
| Ports open (inbound, from your LAN) | 53/UDP+TCP (DNS), 67/UDP (DHCP, only if using Kea), 80/TCP, 443/TCP |
| Access      | A user with `sudo`, and the ability to run commands as that user over SSH |

You do **not** need to pre-install Docker, Node.js, PostgreSQL, or Redis —
`install.sh` (below) installs everything, including Docker itself.

---

## 2. Server setup

```bash
# 1. Clone the repo
git clone https://github.com/manderson20/classguard.git /opt/classguard
cd /opt/classguard

# 2. Run the installer (installs Docker, generates .env, builds and starts everything)
sudo bash install.sh
```

That's it — `install.sh` will:

1. Install Docker Engine + the Compose plugin (skipped if already present).
2. Add your user to the `docker` group.
3. Auto-detect this server's LAN IP and generate `.env` with fresh random
   secrets (`DB_PASSWORD`, `JWT_SECRET`, `INTERNAL_SECRET`) — only on first
   run; it never overwrites an existing `.env`.
4. Build every container (`backend`, `dns-engine`, `frontend`, `kea`,
   `extension-builder`).
5. Start PostgreSQL + Redis, wait for them to be healthy, run database
   migrations, then start everything else.
6. Print the URL to open and the DNS IP to hand out via DHCP.

Takes 5–15 minutes on first run depending on the server's CPU/network speed
(most of it is the Docker image builds).

### Updating to the latest version

Re-run the exact same command — `install.sh` doubles as the update path:

```bash
cd /opt/classguard
sudo bash install.sh
```

It pulls the latest code (skipped with a warning if you've hand-edited
anything in `/opt/classguard` — commit or stash those changes first), then
rebuilds and restarts whatever changed. `.env` is never touched on a
re-run. No separate `git pull`/`docker compose build` steps needed.

### If this server has more than one network interface

`install.sh` picks the IP your default route goes out on. If that's the
wrong NIC, edit `/opt/classguard/.env` and fix **both** `CLASSGUARD_HOST` and
`DNS_BIND_IP` to the correct LAN IP, then:

```bash
cd /opt/classguard
docker compose up -d frontend dns
```

### Useful commands afterward

```bash
docker compose ps                  # check container status
docker compose logs -f api         # stream API logs
docker compose logs -f dns         # stream DNS engine logs
docker compose down                # stop everything
docker compose up -d               # start everything
docker compose run --rm migrate    # re-run migrations (idempotent, safe)
```

### Setting GOOGLE_CLIENT_ID / app domain later

`install.sh` leaves Google OAuth commented out in `.env` — Google sign-in,
Workspace sync, and the Chrome extension all need a real domain and Google
Cloud OAuth credentials, set up in [§5](#5-google-admin--service-account-and-domain-wide-delegation)
and [§6](#6-google-admin--force-installing-the-chrome-extension) below. Once
`APP_URL` changes from an IP to a real domain, rebuild the frontend and
extension so they pick it up:

```bash
docker compose build frontend extension-builder
docker compose up -d frontend
docker compose run --rm extension-builder
```

---

## 3. DNS setup — on-network filtering

Point your school's DHCP server to deliver the ClassGuard server's IP as the
primary DNS resolver for all clients.

### Option A — Router / managed switch DHCP

In your router or switch admin panel, set:

```
DHCP Option 6 (DNS Server): YOUR_SERVER_IP
DHCP Option 6 Secondary:    8.8.8.8   # fallback if ClassGuard is down
```

### Option B — ISC DHCP / Kea (if not using ClassGuard's built-in Kea)

```json
"option-data": [
  { "name": "domain-name-servers", "data": "YOUR_SERVER_IP, 8.8.8.8" }
]
```

### Option C — Windows Server DHCP

1. DHCP Manager > Scope > Scope Options > 006 DNS Servers
2. Add `YOUR_SERVER_IP` as the first entry.

### Verification

From a client device:

```bash
nslookup example.com YOUR_SERVER_IP
# Should resolve; blocked domains return the block page IP
```

---

## 4. Off-network filtering — pushing the DoH profile via MDM

Use `infrastructure/profiles/ios-doh-profile.mobileconfig` to enforce
DNS-over-HTTPS on iOS, iPadOS, and macOS devices when off the school network.

### Before deploying

Edit the profile and replace the two placeholders:

| Placeholder | Replace with |
|-------------|---------------|
| `CLASSGUARD_DOH_URL` | `https://classguard.yourdomain.org/dns-query` |
| `CLASSGUARD_DOH_SERVER_NAME` | `classguard.yourdomain.org` |

Also generate two fresh UUIDs (`uuidgen`) and replace the `PayloadUUID` values.

### Jamf Pro

1. Devices > Configuration Profiles > Upload > choose the `.mobileconfig` file.
2. Scope the profile to your student device group.
3. Save and distribute.

### Mosyle

1. Management > Profiles > Add Profile > Custom Profile.
2. Upload the `.mobileconfig` file.
3. Assign to devices and deploy.

### Apple Configurator 2

1. File > Add Payload > Custom Profile.
2. Select the `.mobileconfig` file.
3. Apply to connected devices or export as a supervised profile.

---

## 5. Google Admin — service account and domain-wide delegation

The Google Workspace Sync service (`POST /api/v1/sync/google`) requires a
service account with domain-wide delegation to read users, groups, and OUs.

### Step 1 — Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create
   a project named **ClassGuard**.
2. Enable the **Admin SDK API**:
   APIs & Services > Library > "Admin SDK API" > Enable.

### Step 2 — Create a service account

1. IAM & Admin > Service Accounts > Create Service Account.
2. Name: `classguard-sync`, Description: `ClassGuard directory sync`.
3. Click **Done** (no roles needed at the project level).
4. Click the service account > Keys > Add Key > Create new key > JSON.
   Download it and place it on the server:
   ```bash
   sudo mkdir -p /etc/classguard
   sudo mv ~/Downloads/classguard-sync-*.json /etc/classguard/service-account-key.json
   sudo chmod 600 /etc/classguard/service-account-key.json
   ```
5. Note the **Client ID** (numeric, shown in the service account details).

### Step 3 — Enable domain-wide delegation

In your **Google Workspace Admin Console** (admin.google.com):

1. Security > Access and data control > API controls.
2. Manage Domain Wide Delegation > Add new.
3. Client ID: paste the numeric client ID from Step 2.
4. OAuth Scopes (comma-separated):
   ```
   https://www.googleapis.com/auth/admin.directory.user.readonly,
   https://www.googleapis.com/auth/admin.directory.group.readonly,
   https://www.googleapis.com/auth/admin.directory.orgunit.readonly
   ```
5. Click Authorize.

### Step 4 — Configure ClassGuard

In `/opt/classguard/.env` (the repo root, **not** `backend/.env`):

```env
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/etc/classguard/service-account-key.json
SUPERADMIN_EMAIL=youradmin@yourdomain.org
GOOGLE_WORKSPACE_DOMAIN=yourdomain.org
GOOGLE_CUSTOMER_ID=C0xxxxxxxxx   # optional; defaults to "my_customer"
```

Then recreate the API container so it picks up the change — `docker compose
restart` does **not** reload `.env`, you need `up -d` to recreate it:

```bash
cd /opt/classguard && docker compose up -d api
```

### Step 5 — Run the first sync

```bash
curl -X POST https://classguard.yourdomain.org/api/v1/sync/google \
  -H "Authorization: Bearer <admin-jwt>"
```

Check status:

```bash
curl https://classguard.yourdomain.org/api/v1/sync/status \
  -H "Authorization: Bearer <admin-jwt>"
```

---

## 6. Google Admin — force-installing the Chrome extension

### Build the extension package

The extension's manifest needs this server's Google OAuth client ID baked in
at build time (`chrome.identity.getAuthToken` requires it to be static, not
loaded at runtime). Build it once after `GOOGLE_CLIENT_ID`/`APP_URL` are set
in `.env`:

```bash
cd /opt/classguard
docker compose build extension-builder
docker compose run --rm extension-builder
```

This writes the extension build to a shared volume that the frontend
container serves at `https://classguard.yourdomain.org/downloads/`. Admin →
Settings → Extension tab has a **Download Extension** button that fetches
the same files. Re-run the two commands above any time `GOOGLE_CLIENT_ID` or
`APP_URL` changes — the server's URL itself does *not* require a rebuild,
since the extension discovers it at runtime via `chrome.storage.managed`
(see "Upload to Google Admin" below).

Use `infrastructure/google-admin/forced-extension-policy.json`.

### Before uploading

Replace the placeholders in the JSON:

| Placeholder | Replace with |
|-------------|---------------|
| `EXTENSION_ID` | Your published extension's Chrome Web Store ID |
| `CLASSGUARD_BACKEND_URL` | `https://classguard.yourdomain.org` |
| `CLASSGUARD_GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console |

### Upload to Google Admin

1. Devices > Chrome > Apps & Extensions > Users & Browsers.
2. Select the target OU (e.g., `/Students`).
3. Click **+** > Add from Chrome Web Store > enter the Extension ID.
4. Set **Installation policy** to **Force install**.
5. Under **Policy for extensions**, paste the `managed_configuration` block
   from the JSON file.
6. Save.

Students will receive the extension silently on their next Chrome sign-in.
It cannot be removed or disabled by the user.

---

## 7. TLS certificate — Let's Encrypt via DNS-01

ClassGuard issues and renews its own Let's Encrypt certificate internally —
there's no Certbot, no Nginx plugin, and nothing to install. It uses the
DNS-01 challenge type specifically because that doesn't require this server
to be reachable from the public internet on port 80 (HTTP-01's requirement);
it only needs API access to your DNS provider to create a temporary TXT
record.

### Configure (Admin UI)

Go to **Admin → High Availability & Config → TLS Certificate** and either:

- **Automatic** — enter your domain and a Cloudflare API token or AWS Route
  53 credentials (whichever hosts your DNS zone), then click **Issue
  Certificate**. ClassGuard creates the TXT record, validates, and installs
  the cert itself.
- **Manual** — if your DNS provider isn't Cloudflare/Route53, click **Start
  Manual Challenge**, add the TXT record it gives you wherever your DNS is
  hosted, then click **Confirm** once it's published.

### Configure (API, if you'd rather script it)

```bash
curl -X PUT https://YOUR_SERVER_IP/api/v1/tls \
  -H "Authorization: Bearer <superadmin-jwt>" -H "Content-Type: application/json" \
  -d '{
    "domain": "classguard.yourdomain.org",
    "acme_email": "you@yourdomain.org",
    "provider": "cloudflare",
    "cloudflare_api_token": "YOUR_TOKEN"
  }'

curl -X POST https://YOUR_SERVER_IP/api/v1/tls/issue \
  -H "Authorization: Bearer <superadmin-jwt>"
```

### Renewal

Fully automatic — a daily 5am job checks expiry and renews within 30 days
of it (`backend/src/services/scheduler.js`). Nothing to schedule yourself.

---

## 8. Database backups

PostgreSQL runs inside the `postgres` container, so backups go through
`docker compose exec`/`docker exec`, not a host-installed `pg_dump`.

### Daily pg_dump via cron

```bash
sudo mkdir -p /var/backups/classguard
```

```bash
# /etc/cron.d/classguard-backup
0 2 * * * root docker exec classguard-postgres pg_dump -U classguard classguard | gzip > /var/backups/classguard/classguard-$(date +\%F).sql.gz
0 3 * * * root find /var/backups/classguard -name "*.sql.gz" -mtime +30 -delete
```

### Restore

```bash
gunzip -c /var/backups/classguard/classguard-2026-06-15.sql.gz | docker exec -i classguard-postgres psql -U classguard classguard
```
