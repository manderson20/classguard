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

### Added (Phases 4–9 complete)
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
