# ClassGuard — Deployment Guide

This guide covers a single-server production deployment on Ubuntu 22.04/24.04.
For multi-node HA, see `imageref/ClassGuard-Specification.md §11`.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Server setup](#2-server-setup)
3. [DNS setup — on-network filtering](#3-dns-setup--on-network-filtering)
4. [Off-network filtering — pushing the DoH profile via MDM](#4-off-network-filtering--pushing-the-doh-profile-via-mdm)
5. [Google Admin — service account and domain-wide delegation](#5-google-admin--service-account-and-domain-wide-delegation)
6. [Google Admin — force-installing the Chrome extension](#6-google-admin--force-installing-the-chrome-extension)
7. [SSL certificate — initial issue and auto-renewal](#7-ssl-certificate--initial-issue-and-auto-renewal)
8. [Database backups](#8-database-backups)

---

## 1. Prerequisites

| Requirement | Minimum |
|-------------|---------|
| Ubuntu      | 22.04 LTS |
| RAM         | 4 GB |
| Disk        | 40 GB SSD |
| Public IP   | Static (or DDNS) |
| Domain name | A record pointing to server IP |
| Ports open  | 53/UDP, 53/TCP, 80/TCP, 443/TCP |

Install Node.js 20, PostgreSQL 15 + TimescaleDB, Redis 7, Nginx, PM2, and Certbot
as documented in the bootstrap script in `imageref/ClassGuard-Specification.md §2`.

---

## 2. Server setup

```bash
# Clone the repo
git clone https://github.com/manderson20/classguard /opt/classguard

# Install backend dependencies
cd /opt/classguard/backend && npm ci --omit=dev

# Install dns-engine dependencies
cd /opt/classguard/dns-engine && npm ci --omit=dev

# Build the frontend
cd /opt/classguard/frontend && npm ci && npm run build

# Create log directory
sudo mkdir -p /var/log/classguard
sudo chown $USER /var/log/classguard

# Copy and edit environment file
cp /opt/classguard/backend/.env.example /opt/classguard/backend/.env
# Edit .env with your DATABASE_URL, REDIS_URL, JWT_SECRET, GOOGLE_*, etc.

# Run database migrations
cd /opt/classguard/backend && node src/scripts/migrate.js

# Start processes
pm2 start /opt/classguard/infrastructure/pm2/ecosystem.config.js --env production
pm2 save
pm2 startup    # follow the printed command to enable on boot
```

---

## 3. DNS setup — on-network filtering

Point your school's DHCP server to deliver the ClassGuard server's IP as the
primary DNS resolver for all clients.

### Option A — Router / managed switch DHCP

In your router or switch admin panel, set:

```
DHCP Option 6 (DNS Server): <CLASSGUARD_SERVER_IP>
DHCP Option 6 Secondary:    8.8.8.8   # fallback if ClassGuard is down
```

### Option B — ISC DHCP / Kea

In your Kea configuration (`/etc/kea/kea-dhcp4.conf`), add to the subnet options:

```json
"option-data": [
  { "name": "domain-name-servers", "data": "CLASSGUARD_SERVER_IP, 8.8.8.8" }
]
```

### Option C — Windows Server DHCP

1. DHCP Manager > Scope > Scope Options > 006 DNS Servers
2. Add `CLASSGUARD_SERVER_IP` as the first entry.

### Verification

From a client device:

```bash
nslookup example.com CLASSGUARD_SERVER_IP
# Should resolve; blocked domains return 0.0.0.0
```

---

## 4. Off-network filtering — pushing the DoH profile via MDM

Use `infrastructure/profiles/ios-doh-profile.mobileconfig` to enforce
DNS-over-HTTPS on iOS, iPadOS, and macOS devices when off the school network.

### Before deploying

Edit the profile and replace the two placeholders:

| Placeholder | Replace with |
|-------------|--------------|
| `CLASSGUARD_DOH_URL` | `https://classguard.school.org/dns-query` |
| `CLASSGUARD_DOH_SERVER_NAME` | `classguard.school.org` |

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
   Download and store the key file securely on the server:
   ```
   /etc/classguard/service-account-key.json
   chmod 600 /etc/classguard/service-account-key.json
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

In `/opt/classguard/backend/.env`:

```env
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/etc/classguard/service-account-key.json
SUPERADMIN_EMAIL=youradmin@school.org
GOOGLE_WORKSPACE_DOMAIN=school.org
GOOGLE_CUSTOMER_ID=C0xxxxxxxxx   # optional; defaults to "my_customer"
```

### Step 5 — Run the first sync

```bash
curl -X POST https://classguard.school.org/api/v1/sync/google \
  -H "Authorization: Bearer <admin-jwt>"
```

Check status:

```bash
curl https://classguard.school.org/api/v1/sync/status \
  -H "Authorization: Bearer <admin-jwt>"
```

---

## 6. Google Admin — force-installing the Chrome extension

Use `infrastructure/google-admin/forced-extension-policy.json`.

### Before uploading

Replace the placeholders in the JSON:

| Placeholder | Replace with |
|-------------|--------------|
| `EXTENSION_ID` | Your published extension's Chrome Web Store ID |
| `CLASSGUARD_BACKEND_URL` | `https://classguard.school.org` |
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

## 7. SSL certificate — initial issue and auto-renewal

### Initial issue (Certbot + Nginx plugin)

```bash
sudo certbot --nginx -d classguard.school.org
```

Certbot edits the Nginx config automatically. Verify:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Enable auto-renewal

Certbot installs a systemd timer by default. Verify it is active:

```bash
systemctl status certbot.timer
```

If not present, add a cron entry:

```bash
# /etc/cron.d/certbot
0 3 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx"
```

Test dry-run:

```bash
sudo certbot renew --dry-run
```

---

## 8. Database backups

### Daily pg_dump via cron

```bash
# /etc/cron.d/classguard-backup
0 2 * * * postgres pg_dump classguard | gzip > /var/backups/classguard/classguard-$(date +\%F).sql.gz
```

Create the backup directory:

```bash
sudo mkdir -p /var/backups/classguard
sudo chown postgres /var/backups/classguard
```

### Retention — keep 30 days

```bash
# Add to the same cron entry (chain with &&):
find /var/backups/classguard -name "*.sql.gz" -mtime +30 -delete
```

### Restore

```bash
gunzip -c /var/backups/classguard/classguard-2026-06-15.sql.gz | psql classguard
```
