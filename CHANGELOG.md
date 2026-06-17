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
[Unreleased]: https://github.com/manderson20/classguard/compare/v0.0.4...HEAD
[0.0.4]: https://github.com/manderson20/classguard/compare/v0.0.1...v0.0.4
[0.0.1]: https://github.com/manderson20/classguard/releases/tag/v0.0.1
