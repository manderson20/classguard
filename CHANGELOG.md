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

> No changes staged yet.

---

## [0.2.0] - 2026-06-21

### Added

- **Integrations → Google Workspace** restructured into sub-tabs (Device &
  Directory Sync, SSO Login, Chrome Extension, YouTube Data API) so the
  three distinct Google credential types (web-app SSO client, Chrome
  Extension OAuth client, service account) aren't mixed together in one
  form anymore. Google Workspace service account JSON, Chrome Extension
  OAuth client ID, and Mosyle admin credentials are now all entered and
  stored from the UI — no more hand-editing `.env` or key files on the host.
- **Extension builds rebuild themselves automatically** — `extension-builder`
  is now a persistent service that polls Settings every ~60s and rebuilds
  whenever the OAuth client ID or public URL changes, instead of needing a
  manual `docker compose run` after every config edit.
- Trusted-app pre-authorization instructions added to the Chrome Extension
  deployment steps, so students aren't shown (and can't decline) a Google
  consent prompt on first run.
- **Devices table pagination** — page-size selector and Prev/Next controls
  plus a search box on Integrations → All Devices, instead of a hard 50-row
  cap with no way to see the rest.
- **Automatic staff/student role detection from Google OU**, configurable
  per-district under Integrations → Google Workspace → Role Mapping by OU
  (longest-matching-OU-prefix wins, e.g. one `/Employees` rule covers every
  staff sub-OU). New users from directory sync or first Google sign-in get
  the right role automatically instead of everyone defaulting to `student`
  — which previously locked every staff member out of the admin app on
  Google SSO login. A role changed manually on the Users page is never
  overwritten by this. Includes a preview table of OUs not yet covered by a
  rule (with live user counts) and an on-demand re-apply action so editing
  the rules doesn't require waiting for the next scheduled sync.
- **SSO login now supports multiple Workspace domains** (comma-separated) —
  needed wherever staff and students are issued accounts on different
  domains/subdomains of the same Workspace tenant.
- **Unified device view** — Integrations → All Devices now shows one row per
  physical device instead of a separate row per integration, merging
  Snipe-IT/Mosyle/Google Chromebook records by serial number and overlaying
  live "on network" status (IP, AP, SSID) from the UniFi controller by MAC
  match. A "Sources" column shows which integrations have a record for each
  device; asset/ownership fields prefer Snipe-IT, technical fields (OS,
  name, model) prefer the MDM that reported them.

### Fixed

- Chrome extension shipped with an empty `oauth2.client_id` — Chrome
  silently refuses to install *any* extension with this (no visible error
  anywhere), which is why force-installed devices never showed the
  extension despite a correct Google Admin Console policy.
- Extension builds were baked from a private LAN IP over plain HTTP;
  Chrome blocks self-hosted (non-Chrome-Web-Store) extension installs and
  updates that aren't served over HTTPS.
- Google Workspace device/directory sync was fully broken: the groups
  upsert didn't match its own partial unique index, the users upsert
  conflicted on a nullable column instead of email, and some Chromebooks'
  TPM data contains raw binary that violates Postgres's `jsonb` NUL-byte
  restriction and silently aborted the sync partway through every run.
- Mosyle device sync was pointed at the wrong product's API entirely
  (Mosyle Business instead of Mosyle Manager, the K-12 product actually in
  use) and assumed a now-deprecated token-only auth mode. Now uses the
  correct API and the required JWT login (admin email/password exchanged
  for a 24h session token).
- Integrations status badges conflated unrelated credentials (e.g. Google
  SSO login vs. the service account needed for directory sync) and shared
  error state between the directory sync and device sync, making
  "configured"/error display misleading for both Google and Mosyle.
- **Google directory sync only ever pulled one Workspace domain** — most
  real student accounts live on a different domain/subdomain than staff, so
  the vast majority of the student body (student count went from 42 to
  2,958 once fixed) was silently never synced at all. Now syncs the whole
  Workspace account (matching how org-unit sync already worked), not just
  one configured domain.
- `/policies/ou-list` (used by both the policy assignment OU picker and the
  new role-mapping UI) only ever showed OUs that already had a synced user
  or existing assignment — most of the real OU tree was invisible. Now
  returns the full OU tree from the last directory sync.

---

## [0.1.0] - 2026-06-20

Bumped MINOR, not PATCH — this release moves ClassGuard from a single-server
deployment to a genuinely working multi-server HA cluster (replication +
failover tested live between two physical servers), alongside several new
policy/integration features.

### Added

- **On/off-campus policy layer** — DNS-level network floor (applies to every
  device on a subnet, regardless of OU) plus OU-level extension policy on
  top, so students and staff can be filtered separately. GoGuardian CSV
  import for migrating existing policies.
- **NAC / RADIUS integrations** — OAuth client-credentials auth for
  Snipe-IT, UniFi controller session caching, RADIUS NAS auto-provisioning
  from MDM/network-controller sources, BYOD policy + Secure LDAP setup
  wizard.
- **Phone directory and DHCP↔IPAM integration** — phone system import,
  device-level DNS tracking across integration sources.
- **Let's Encrypt DNS-01 automation** and a Database Replication status
  panel on the HA page.
- **`install.sh` now doubles as the update path** — re-running it on an
  existing install pulls the latest code and rebuilds only what changed;
  no separate manual `git pull`/`docker compose build` steps.
- **Full HA cluster join, entirely from the UI** — generate an invite on
  the primary, paste the URL + token into the joining node's own "Join a
  Primary Cluster" form. No CLI or SSH access to either server required.
- **One-click-adjacent Postgres streaming replication setup** — the primary
  issues a scoped, rotation-safe replication credential and a dedicated
  replication slot per node; the joining node gets a ready-to-paste script
  that bases-back-up and brings up a real streaming standby.
- **Standbys can now actively serve DNS**, not just sit idle as a cold
  failover spare — query logs from a standby forward to the primary so
  history stays unified regardless of which node answered the query.
- **Real VRRP failover via keepalived** — virtual IP automatically moves to
  whichever node is healthy, with live state (MASTER/BACKUP/FAULT) reported
  back to the Cluster Nodes list. Tested end-to-end on two physical
  servers: stopping the primary handed off the VIP (and the admin UI)
  to the standby within seconds; restarting the primary reclaimed it via
  priority preemption.
- **Settings page** reorganized into tabs.

### Fixed

- Kea's control-socket path and an unsubstituted `DB_PASSWORD` in its config.
- Kea was sharing the app's database, which made `db-init` impossible on
  any fresh install — gave it a dedicated database.
- `install.sh` could die under `set -e` during IP auto-detection on a
  minimal/offline base image, and a first-boot TimescaleDB tuning restart
  could race a naive readiness check.
- `docker-compose.override.yml` was tracked in git and silently forced
  every fresh install into dev mode — untracked it.
- Deployment docs described a PM2/bare-metal setup that no longer exists;
  rewritten to match the real Docker/`install.sh` path.
- A whole cluster of HA bugs found only by actually deploying replication
  and VRRP on two real servers rather than just reviewing the code: a
  partial-unique-index mismatch meant `/join` had never actually
  succeeded for any node; rotating the shared replication credential on
  every join silently broke every other already-connected standby;
  migrations could block `api` from ever starting on a read-only standby;
  the admin UI didn't resolve when reached via the VRRP virtual IP; and
  keepalived's own health-check/notify scripts were calling unreachable
  ports and unauthenticated endpoints.

---

## [0.0.4] - 2026-06-17

### Added

- **Block page branding** — IT admins can customise the "This website is blocked" page from Settings: school logo (drag-and-drop, base64), school name, custom message, contact email, and primary colour with 8 preset swatches. Live preview mirrors the actual block page in real time. Branding is served via public `GET /api/v1/branding` endpoint (5-minute CDN cache) consumed by both the extension and DNS sinkhole page.

- **DNS sinkhole block page** (`frontend/public/blocked-dns.html`) — standalone page served by nginx's `default_server` block when DNS returns the ClassGuard IP for a blocked domain. Fetches branding same-origin (no CORS); applies school logo/colours dynamically. Includes the unblock request button and a subtle "Have an override code?" secondary link.

- **Unblock request workflow** — students and staff can request access to a blocked site directly from the block page. A single visible "Request to unblock this website" button expands an inline reason field. Controlled by the `unblock_requests_who` setting (all / staff / off); extension additionally gates visibility by Google OU. Backend stores requests in `unblock_requests` table with partial unique indexes preventing duplicate pending submissions (409 on re-submit).

- **Admin unblock request workflow** (`/admin/unblock-requests`) — pending / approved / denied tabs; table shows domain, requester name, email, OU, reason, and timestamp. Actions on pending: Approve, + Generate Override Code (opens modal with duration picker and copy button), Deny with optional note. Sidebar nav badge shows pending count, refreshes every 60 seconds.

- **Override codes** — admins generate time-limited 8-character codes (charset excludes `0/O/1/I/L` for readability) that bypass a policy block for a specific domain. CIPA-floor categories (`adult`, `violence`, `weapons`, `gambling`, `drugs_alcohol`, `hate_speech`, `phishing`, `malware`) are blocked from override at generation time. Code is marked used on first verification; Redis key `classguard:override:{ip}:{domain}` with TTL drives DNS resolver Step 6.5. Extension stores active overrides in `chrome.storage.local` (`cg_overrides`) and re-applies them on every policy sync via `buildRules()`.

- **YouTube video rules** — per-policy allow/block list for individual YouTube videos. Search by URL or 11-character video ID; fetches title, thumbnail, channel, and category from YouTube Data API v3 before adding. Policy editor YouTube tab now has a Video Rules panel alongside channel and category controls.

- **Policy filter simulator** (`/admin/policy-simulator`) — enter a domain or URL to see exactly which policy would apply, which rule matched, and why, across all active policies and OUs.

- **Staff analytics** (`/admin/staff-analytics`) — per-teacher breakdown of lesson activity: lessons run, total lesson time, penalty box usage, and class engagement metrics over selectable time windows.

- **Screenshot capture** — extension content script scans page text for configurable blocked keywords; on match the service worker calls `chrome.tabs.captureVisibleTab()` and POSTs to `/api/v1/extension/screenshot`. Teachers can also request live screenshots via Socket.io push. Optional AI vision analysis (Claude / OpenAI) flags screenshots by category. Admin review UI at `/admin/screenshots`.

- **Managed Chrome extension** (GoGuardian deployment model) — server URL and Google Client ID read from `chrome.storage.managed` at runtime; no per-school rebuild required. `managed_schema.json` ships with the extension. Settings page generates ready-to-paste Google Admin policy JSON.

- **FreeRADIUS / NAC integration** — MAB for device authentication, EAP-TTLS/PAP for user authentication against Google Secure LDAP (fixes Android MSCHAPv2 incompatibility). Device status: `approved` / `blocked` / `pending`. VRRP/Keepalived HA config generated from the UI with downloadable `keepalived.conf` bundle.

- **Multi-source device tracking** — each device shows source badges for every system it appears in (Mosyle, Snipe-IT, Google Admin, network controllers). Deprovisioning flow: removal from all MDM sources demotes device to `pending`; `blocked` is never auto-changed.

- **AI domain classification** — privacy-first (only bare domain sent, no PII). Supports Anthropic Claude (Haiku default), OpenAI-compatible APIs, and local Ollama. 30-day DB cache. Admin UI with on-demand classify, batch, and stats.

- **Network infrastructure** — UniFi, Meraki, Aruba, and Ruckus controller adapters with a factory-pattern vendor abstraction. Multiple controllers per vendor. Clients, access points (with client count + RSSI), and DNS forward zones (Windows AD split-horizon) tabs.

- **Roster sync** — Google Classroom (courses, rosters, profiles via service account) and OneRoster 1.1 (OAuth2 client credentials, Infinite Campus token URL pattern). Multi-source SIS support. `RosterPage.jsx` with per-source sync, test-connection, and course map table.

- **HA cluster invite workflow** — admins click "+ Add Server", choose a role, and get a single-use 7-day invite token with a copy-able `docker compose` command. New server calls `POST /api/v1/ha/join` with the token and self-registers. Pending invites listed with revoke button. `NODE_ID` and `hostname` now stable in `docker-compose.yml` to prevent phantom node accumulation.

- **DNS records management** (`/admin/dns/records`) — internal DNS record CRUD (A, AAAA, CNAME, MX, TXT, SRV) served by the ClassGuard DNS engine.

- **Full IPAM** — sections, VRFs, VLANs, locations, nested subnets (IPv4/IPv6), BGP prefixes, NAT rules. ISC Kea 2.6 integration for live lease data, subnet utilisation bars, reservation CSV import, force-expire leases, HA status widget.

- **Integration hub** — Zammad (ticketing), Mosyle MDM, Snipe-IT asset management, Google Admin Chromebook sync, and PHPiPAM import wizard. `integration_devices` unified table with per-source badges.

### Fixed

- **HA phantom nodes** (migration 025) — `registerSelf()` referenced a non-existent `node_id` column; `ON CONFLICT` silently fell back to plain `INSERT`, creating one row per Docker container restart (19 accumulated). Fixed: added `node_id` column, deleted phantom rows, set stable `NODE_ID=classguard-1` and `hostname=classguard-api` in `docker-compose.yml`.

- **Migration 024 immutable function** — `override_codes_code_active_idx` originally included `expires_at > NOW()` in the partial index predicate; `NOW()` is not `IMMUTABLE`. Fixed by moving the expiry check to query time.

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
[Unreleased]: https://github.com/manderson20/classguard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/manderson20/classguard/compare/v0.0.4...v0.1.0
[0.0.4]: https://github.com/manderson20/classguard/compare/v0.0.1...v0.0.4
[0.0.1]: https://github.com/manderson20/classguard/releases/tag/v0.0.1
