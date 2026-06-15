# Changelog

All notable changes to ClassGuard will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version numbers follow `MAJOR.MINOR.PATCH`:
- **MAJOR** — breaking changes or full milestone releases
- **MINOR** — new features or significant additions
- **PATCH** — bug fixes, minor improvements, documentation updates

---

## [Unreleased]

> Changes staged for the next release are listed here during development.
> This section is moved and dated when a release is cut.

### Added (Phases 4–10 + integrations, full IPAM, HA, NTP, Windows AD prep)
- **Phase 4 — Policy Engine**: `policyResolver` service with full 6-level precedence chain
  (lesson → penalty_box → student → group → OU → district default); 60-second Redis cache;
  full CRUD routes for policies, assignments, groups, classes, penalty box, and users
- **TimescaleDB migration** (003): hypertable on `dns_logs` (1-day chunks), 2-day compression,
  90-day retention, `dns_stats_hourly` continuous aggregate
- **DNS logs & stats API**: paginated query history with teacher-scoped filtering;
  `time_bucket` aggregations using TimescaleDB continuous aggregate
- **Schema constraints** (004): partial unique indexes for penalty box and policy assignments;
  `placed_at` column rename; `lesson_sessions.name` field
- **Phase 5 — Chrome Extension (MV3)**: service worker with Google OAuth via
  `chrome.identity`, `declarativeNetRequest` policy enforcement (lesson whitelist,
  penalty box block-all, custom deny/allow lists), real-time Socket.io policy updates,
  tab activity reporting, blocked page, popup UI; webpack build pipeline
- **Extension backend routes**: `/extension/auth` (access-token exchange), `/extension/register`
  (IP→student Redis mapping), `/extension/heartbeat`, `/extension/tab-event` (Redis stream +
  Socket.io emit), `/extension/policy`
- **Phase 6 — Teacher Dashboard (React)**: Vite + React 18 + TanStack Query + Tailwind CSS;
  Google OAuth login, class list, class detail with real-time student activity monitoring,
  active lesson view (grid + activity log), lesson start modal with quick-add domains,
  penalty box management page
- **IPAM foundation**: `ip_addresses` and `dns_records` tables extending `dhcp_subnets` as
  the subnet source of truth; full CRUD API for subnets, IP address documentation, DNS
  records; live Kea lease integration for subnet utilization maps; conflict detection
  (static IPs in DHCP pool without reservations)
- **Real-time student activity**: Socket.io bridge from extension tab events to teacher
  class rooms via Redis-cached class membership; `student:activity` events highlight
  navigations in the active lesson view
- **Phase 8 — Google Workspace Sync**: `services/google.js` with `initGoogleAdmin()`
  (service account + domain-wide delegation), `syncUsers()` (paginated upsert + deactivate
  stale users), `syncGroups()` (upsert groups + members), `syncOrgUnits()` (OU tree stored
  in settings as JSON); exponential backoff for rate limits; audit log entries per sync step
- **Sync routes**: `POST /api/v1/sync/google` (async trigger, admin+),
  `GET /api/v1/sync/status` (last sync time + active user/group counts)
- **Migration 006**: partial unique index on `groups.google_group_email` (WHERE NOT NULL)
  enabling upsert on Google-backed groups while allowing multiple NULL rows
- **Phase 9 — Deployment configs**:
  - `infrastructure/profiles/ios-doh-profile.mobileconfig`: Apple Configuration Profile
    (MV3 plist) deploying DoH to iOS/iPadOS/macOS via Jamf, Mosyle, or Apple Configurator
  - `infrastructure/google-admin/forced-extension-policy.json`: Chrome policy JSON that
    force-installs the ClassGuard extension with managed-storage config; includes upload guide
  - `infrastructure/nginx/classguard.conf`: production Nginx config with HTTPS redirect,
    TLS (Certbot placeholders), security headers, React SPA serving, API proxy,
    Socket.io upgrade, and DoH endpoint proxy
  - `infrastructure/pm2/ecosystem.config.js`: PM2 ecosystem managing `classguard-api`
    and `classguard-dns` with OOM restarts and structured log paths
  - `DEPLOYMENT.md`: end-to-end deployment guide covering DNS/DHCP setup, MDM DoH
    profile delivery, Google service account + domain-wide delegation (step-by-step),
    Chrome extension force-install, SSL renewal, and pg_dump backup cron
- **Phase 10 — DHCP Management (ISC Kea Integration)**:
  - `services/kea.js`: full Kea Control Agent client — `keaCommand()`, `syncSubnet()`
    (update-or-add), `deleteSubnet()`, `syncReservation()`, `deleteReservation()`,
    `getLeases()`, `getLease()`, `deleteLease()`, `getStats()`, `getHAStatus()`
    (polls all DHCP_NODE_URLS, returns per-node HA state)
  - `routes/dhcp.js`: full implementation of all 14 DHCP routes — subnet CRUD
    (synced to Kea), reservation CRUD (IP validated within pool), lease proxy
    (joined with devices/users), stats, HA status, full DB→Kea resync endpoint
  - `DhcpManagement.jsx`: three-tab admin page (Subnets / Reservations / Active Leases);
    subnet utilization progress bars from Kea stats; reservation CSV import;
    active-lease table auto-refreshing every 30s with force-expire and CSV export;
    HA status widget showing per-node state badges
  - `infrastructure/kea/`: Kea 2.6 Docker image with PostgreSQL lease + hosts database,
    Control Agent config, and idempotent schema-init entrypoint
  - `frontend/Dockerfile`: multi-stage build (Vite → nginx:alpine); `nginx.conf` for SPA routing
  - `docker-compose.override.yml`: dev mode — mounts source directories for `--watch` hot reload
- **First-run setup wizard**: `GET /auth/setup-status` detects empty users table; `POST /auth/setup`
  creates first superadmin; Setup.jsx wizard page redirects to settings on completion
- **Local password auth**: `POST /auth/login` using `crypto.scryptSync` + `timingSafeEqual`
  (no external deps); password min 10 chars enforced in UI
- **Google OAuth UI config**: all Google credentials readable/writable via `PUT /api/v1/settings`;
  `GET /auth/public-config` surfaces clientId for login page; `getGoogleConfig()` checks DB
  settings with env-var override
- **Settings API** (`routes/settings.js`): admin-only; ALLOWED_KEYS whitelist; upsert via
  `ON CONFLICT (key)` pattern; covers Google, Zammad, Mosyle, Snipe-IT, PHPiPAM, LDAP keys
- **Migration 007**: `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`
- **Full IPAM replacement** (migration 008):
  - `ipam_sections`, `locations`, `vrfs`, `vlans` tables for organisational hierarchy
  - `ipam_subnets` with IPv4/IPv6, nested subnets (`parent_id`), section/VRF/VLAN/location FK,
    gateway, dns_servers, DHCP link, tags, notes
  - `bgp_prefixes` — prefix, ASN, peer ASN/IP, next-hop, origin (IGP/EGP/INCOMPLETE), status,
    communities array, VRF FK; covers both IPv4 and IPv6
  - `nat_rules` — source/destination/masquerade/static/PAT types, src/dst prefix, port ranges,
    protocol, interface, active flag
  - `ip_addresses` extended: ipam_subnet_id, ip_version, status (used/free/reserved/offline/dhcp),
    ping_status, last_seen
- **IPAM API extended** (`routes/ipam.js`): full CRUD for sections, VRFs, VLANs, locations,
  ipam-subnets (with filtering), BGP prefixes, NAT rules
- **IpamFullPage.jsx**: tabbed admin page — Subnets (IPv4/IPv6 filter), VLANs, VRFs, Sections
  (color swatch), BGP prefixes (origin/status badges, offset bar), NAT rules; all tabs with
  add/edit/delete modals; links back to classic subnet view
- **Integration suite** (migration 009 + `routes/integrations.js` + four service modules):
  - `integration_devices` table with source enum, serial, MAC array, OS type/version, assigned
    user/email, IP addresses, status, raw_data JSONB
  - `zammad_tickets` table linked to devices and IPs
  - **Zammad** (`services/zammad.js`): Token auth; list/get/create ticket, add note, syncTickets;
    reads URL+token from settings or env
  - **Mosyle MDM** (`services/mosyle.js`): form-encoded POST with accesstoken; iOS/macOS/tvOS
    device list; upserts to integration_devices
  - **Snipe-IT** (`services/snipeit.js`): Bearer token; paginated asset list (500/page); upserts
    to integration_devices
  - **Google Admin Chromebook sync** (inline in integrations.js): pages ChromeOS device list,
    upserts mac_addresses array, serialNumber, model, annotatedUser, lastSync
  - **PHPiPAM import** (`services/phpipam.js`): authenticates, imports sections → VRFs → VLANs
    → subnets → IP addresses, revokes token; async with progress callbacks
  - `IntegrationsPage.jsx`: tabbed hub — Overview (4 status cards), All Devices (source filter),
    per-integration tabs with sync buttons, credential settings modals, Zammad ticket creation form,
    PHPiPAM migration wizard with connection test
- **HA cluster management** (migration 010 + `routes/ha.js`):
  - `nodes` table extended: ha_role (primary/standby/replica), api_url, last_seen, db_lag_bytes, version
  - Self-registration on startup + 30s heartbeat via `startHeartbeat()`
  - `GET /ha/nodes` probes each node's `/health` in parallel (3s timeout) for real-time health
  - Role change, node removal, summary endpoints
  - `HaPage.jsx`: node cards with role badges, health status, seconds-since-seen; role change modal;
    cluster setup guide; auto-refreshes every 15s
- **NTP monitoring** (migration 010 + `routes/ntp.js` + `services/ntp.js`):
  - Pure Node `dgram` UDP implementation — sends 48-byte NTP client packet, parses stratum,
    reference clock ID, offset (ms), delay (ms), jitter; no external packages
  - `ntp_servers` seeded with Cloudflare + Google NTP; `ntp_peer_status` stores per-poll results
  - CRUD for NTP servers; `POST /ntp/poll` async trigger; `GET /ntp/status` returns synced flag
    and min stratum
  - `NtpPage.jsx`: server list with poll-on-demand, stratum badges, offset visualisation bar,
    reachability column, per-server last-checked timestamp; overall sync status banner
- **Windows AD / LDAP prep**: `ldap_url`, `ldap_bind_dn`, `ldap_bind_password`, `ldap_base_dn`,
  `ldap_user_filter` added to settings ALLOWED_KEYS; foundation for upcoming AD user sync and
  LDAP login support
- **Navigation**: Layout.jsx updated with Integrations, NTP, HA Cluster nav items
- **Routing**: App.jsx updated with `/admin/integrations`, `/admin/ha`, `/admin/ntp`,
  `/admin/ipam/subnets` (classic view preserved)

---

## [0.0.1] - 2026-06-15

### Added
- Initial project specification (`imageref/ClassGuard-Specification.md`) covering:
  - Project goals, non-goals, and architecture overview
  - Full tech stack selection (Node.js, PostgreSQL, Redis, dns2, React, ISC Kea)
  - Feature specifications: Admin Console, Teacher Dashboard, Google Workspace integration,
    DNS filtering engine, policy engine, Chrome extension (MV3), iPad/macOS coverage
  - Complete PostgreSQL database schema
  - High-level API surface (REST + WebSocket events)
  - GitHub repository structure
  - Ubuntu server bootstrap script
  - Phased build plan with AI prompts for Phases 1–10
  - High availability and scalability design (multi-node DNS, Redis Sentinel, PostgreSQL streaming replica)
  - DHCP management via ISC Kea 2.x (subnets, reservations, active lease viewer, HA hot-standby)
  - Docker deployment architecture (7-container compose stack with health checks)
- `VERSION` file
- `CHANGELOG.md` (this file)
- `README.md` with project overview and quick-start reference
- `.gitignore` for Node.js, environment files, build artifacts, and secrets
- GitHub Actions CI workflow skeleton

---

<!-- Links updated each release -->
[Unreleased]: https://github.com/manderson20/classguard/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/manderson20/classguard/releases/tag/v0.0.1
