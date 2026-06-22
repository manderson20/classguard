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

## [0.6.11] - 2026-06-22

### Added
- **Teacher Live View Phase 4**: a teacher's own lesson history.
  - Each class page gained a **Past Lessons** tab listing every lesson session ever run for that class — name, start time, duration, allowed domains, participant count, and blocked-attempt count.
  - Clicking a past lesson expands its full browsing activity (every student, every page visited during just that session), with the same inline "why was this blocked" trace used elsewhere.
  - New `GET /classes/:id/lessons` endpoint, teacher-roster-scoped — stats come from `browser_history.lesson_session_id` (Phase 3).

---

## [0.6.10] - 2026-06-22

### Added
- **Teacher Live View Phase 3**: session-scoped history + filter simulator, from the active-lesson view.
  - `dns_logs` and `browser_history` rows are now tagged with the active `lesson_session_id` (when one applies), threaded through the same Redis-stream pipeline `device_id` already used. Strictly scoped — clears to `NULL` the moment a lesson ends.
  - Each student tile in the live lesson view gained a **History** toggle showing just that student's activity during the current lesson session, with an inline "why was this blocked" trace on flagged rows.
  - The filter simulator (`POST /policies/simulate`) is now teacher-accessible (scoped to their own roster, no raw `policy_id` probing) — each student tile also gained a **Test URL** quick-check.

---

## [0.6.9] - 2026-06-22

### Added

- New **Artificial Intelligence** filter category — chatbots (ChatGPT,
  Claude, Gemini, Character.AI, Copilot, Perplexity, etc.), paraphrasing/
  essay tools (QuillBot, Jasper, Copy.ai), and image/video/voice
  generators (Midjourney, RunwayML, ElevenLabs). Hand-curated since
  neither upstream blocklist source covers AI tools. Opt-in, not blocked
  by default — same tier as Social Media/Gaming/Streaming; add a block
  rule per-policy under Categories if you want it enforced.

---

## [0.6.8] - 2026-06-22

### Fixed

- **RADIUS/NAC's Google Admin (Chromebook) device sync was silently
  no-opping on every run** — it depended on `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`/
  `SUPERADMIN_EMAIL` environment variables that were never set on this
  install, while the DB-backed Google credential (already configured and
  working for Integrations) sat unused. Confirmed live: 0 Chromebooks in
  the RADIUS device list before this fix, 1,319 after.
- RADIUS's three MDM device sources (Mosyle, Snipe-IT, Google Admin) now
  read from the same `integration_devices` table the Integrations page
  uses, instead of independently re-implementing each vendor's API
  field-mapping a second time — eliminates a class of "RADIUS and
  Integrations silently disagree" bugs.
- Snipe-IT assets now capture MAC addresses into `integration_devices`
  (previously never stored there at all).

### Changed

- Network-controller (AP/switch) presence data is no longer treated as a
  RADIUS client-device source at all — it never should have allowed onto
  the network as a user device, only ever provisioned APs/switches
  themselves as RADIUS NAS clients, which is unaffected. Cleaned up 1,017
  unreviewed pending rows this had already created; the 38 devices an
  admin had explicitly approved were preserved.

---

## [0.6.7] - 2026-06-22

### Added

- **Lockdown Browser for tests** — a teacher-initiated lock pinning a
  student's browser to a single test URL (Google Forms today, anything
  else with a direct link tomorrow), with an optional time limit and
  district-wide admin visibility to force a student out if a lockdown
  gets stuck. This is a soft lock: a browser extension can pin the tab,
  close stray tabs/windows, and log escape attempts, but it cannot block
  switching to another application at the OS level the way a native
  kiosk app could. New "Lockdown Tests" page (teachers see their own,
  admins see everyone); start/manage controls added to the Active Lesson
  per-student panel.

---

## [0.6.6] - 2026-06-22

### Added

- **Screen Time tracking** for students — parents have been raising
  concerns about how much screen time their kids get, and there was
  previously no way to even see this. The extension's existing 30-second
  heartbeat now reports `chrome.idle` active/idle/locked state, stitched
  server-side into continuous active-time intervals. New **Screen Time**
  admin page shows active minutes per student over a date range, sorted
  heaviest-first. Recording/reporting only — no limits or enforcement.
  Covers Chromebooks and Macs (same extension, same deployment mechanism);
  iPads are out of scope since Apple's Screen Time APIs deliberately wall
  usage data off from any remote/MDM-level access.
- **Bell Schedule** admin page and **per-teacher device-activity
  reconciliation** — measures how much of each teacher's *scheduled*
  periods their students actually spent active on a device, independent
  of whether a lesson was ever manually started. A nightly job reconciles
  the bell schedule against rosters and screen-time data; results show up
  as a new "Device activity" column on Staff Analytics.

### Fixed

- Staff Analytics' backend query referenced a nonexistent `lessons` table
  and column, meaning the page was erroring on every load.

---

## [0.6.5] - 2026-06-22

### Added

- **Unblock requests submitted via a signed-in account are now
  cryptographically verified**, not just displayed. The admin review queue
  shows a "Verified" vs "Self-reported" badge so staff can tell a real
  Google-account-backed request from a typed name/email at a glance.

---

## [0.6.4] - 2026-06-22

### Added

- **The unblock-request form on the DNS block page now auto-fills from the
  signed-in Google account** when the ClassGuard extension is present,
  instead of requiring a typed name/email every time. Falls back to the
  manual fields unchanged on a personal/unmanaged device.

---

## [0.6.3] - 2026-06-22

### Fixed

- **A domain that doesn't actually resolve (NXDOMAIN/SERVFAIL/unreachable
  upstream) now lands on the block page**, instead of a silent empty
  response that just showed the browser's own generic DNS error. A domain
  that exists but simply has no record of the queried type (e.g. an
  AAAA-only domain queried for A) is correctly left alone — only genuine
  failures are treated this way.

---

## [0.6.2] - 2026-06-22

### Added

- **Safety Evidence Capture: rule-based risk scoring, proactive (non-text)
  screenshot capture, and a real review workflow.** Keyword-matched and
  newly-proactive (image-only content on a high-risk/uncategorized domain)
  screenshots are now scored by category/severity even with no AI
  configured; a risk score of 85+ emails a configurable staff list and
  banners every logged-in admin/teacher in real time. Screenshots now have
  a proper new/in_review/resolved/dismissed workflow with notes, instead
  of a binary reviewed flag. Added a Settings > Safety Alerts panel to
  configure alert email delivery and manage the flagged-keyword list
  (previously only editable via direct SQL). Added the missing self_harm
  category to the content taxonomy.

---

## [0.6.1] - 2026-06-22

### Added

- **"Why?" button on blocked DNS log and browser-history entries.** Shows
  the exact step-by-step reason a domain was blocked (allowlist, lesson/
  penalty mode, allow/deny rules, blocklist, category) plus the student's
  full policy precedence chain, with the tier that actually applied
  clearly marked. Also fixed the schedule-update UI to plainly state when
  a schedule is already active instead of just disabling the button with
  no explanation.

---

## [0.6.0] - 2026-06-22

### Added

- **Direct-IP browsing can now be blocked per policy.** DNS filtering can't
  see a navigation straight to a literal IP address — no DNS query ever
  happens — so this is enforced entirely by the Chrome extension instead.
  New "Block direct-IP browsing" toggle in a policy's Safety Options;
  on-LAN/private IP ranges are always allowed regardless of the setting.

### Fixed

- **Domain and URL-path rules now reject malformed input** when adding them
  to a policy (manual add, CSV bulk import, and GoGuardian import all
  share the same check now). This closes a real correctness gap, not just
  a validation nicety: an invalid URL-path pattern used to make Chrome's
  `declarativeNetRequest` API reject its *entire* rule batch, silently
  disabling every block/allow/lesson/penalty rule for every device under
  that policy. Wildcards (`*.example.com`, `example.com*`) are unaffected.
- **Scheduling/cancelling a software update from a standby node's own UI**
  (rather than the primary's) failed with "cannot execute INSERT in a
  read-only transaction" — that table only exists on the primary's
  writable database, and unlike the rest of the update flow, scheduling
  never relayed through to it. Now it does, regardless of which node's UI
  you're using.
- **HA Nodes page showed a confusing phantom node** named after the
  literal Docker container hostname (identical on every node), and
  separately, **any node with a real TLS certificate permanently showed
  "Slow"** even when perfectly healthy — its own live-status check got
  redirected to HTTPS and failed certificate validation against a bare IP
  address. Both fixed.
- A standby node deliberately never runs the SCEP (VPN enrollment)
  service, but nginx tried to resolve it at startup anyway — meaning any
  standby pulling this update would have its entire web server fail to
  start, not just the SCEP-specific page. Fixed to resolve lazily instead.

---

## [0.5.0] - 2026-06-21

### Added

- **Extension popup shows its own version number and last policy sync
  time**, visible whether signed in or not — lets an admin check a
  device's state at a glance without devtools.

### Fixed

- **A second, independent bug behind "the extension never tracks
  anything"**, found after the 0.4.0 auth fix actually let a real device
  reach the server for the first time: `/extension/auth` was crashing
  with a 500 on every login because `users.last_login_at` — referenced by
  this route and by Staff Analytics' "last login" sort since both were
  written — was never actually added to the schema. Verified live: once
  fixed, the next automatic retry from a real device went from 500 to
  200, and device registration plus real browser-history rows appeared
  for the first time on this deployment.
- Extension icons now use the dedicated shield mark provided for this
  purpose instead of a cropped wordmark, which was illegible at toolbar
  size.
- The popup's logo was invisible against its own header — both are blue,
  so a thin-line-art mark on a same-color background disappeared
  entirely even though it rendered correctly. Given a white backing plate
  so it actually contrasts.

---

## [0.4.0] - 2026-06-21

### Added

- **Automatic HTTP -> HTTPS redirect** once a real Let's Encrypt cert is
  active — previously port 80 and 443 served identical content with no
  redirect at all, even after a real cert was issued.
- **Quick allow-list action on DNS Logs** — blocked rows now have a
  "+ Allow" action that adds the domain to one or more policies' allow
  list directly from the log, instead of needing to find the right policy
  and type the domain in by hand.
- **NTP client visibility** — a new "Devices Polling This Server" table
  shows which devices are actually using ClassGuard's NTP server (chrony),
  fed by a new cron-installed reporter script in the existing deployment
  bundle. Previously the only way to see this was SSHing in and running
  `chronyc clients` by hand.

### Fixed

- **The DNS block page never showed over HTTPS** — port 443 only ever had
  one server block (the admin SPA), so a blocked site's mismatched
  Host/SNI had nowhere to fall through to, unlike port 80. Since nearly
  every real website is HTTPS-only now, almost every blocked-domain visit
  was hitting this gap: students saw ClassGuard's admin login screen
  instead of "Site Blocked." (The browser's certificate warning for the
  mismatched domain is unavoidable without installing a trusted root CA
  fleet-wide, which ClassGuard deliberately doesn't do — this only fixes
  what's shown after clicking through that warning.)
- **The Chrome extension was never actually monitoring any device** — its
  sign-in used an interactive consent prompt on every automatic attempt
  (install, browser startup, and every 1-minute retry). That kind of
  prompt can't display from an unattended background call without a user
  gesture, so every attempt failed silently, forever — no real student
  device had ever successfully authenticated. Switched to silent
  authentication, which works with no prompt at all on a managed device
  already signed into the school Google account.
- Removed the extension popup's "Sign Out" button — a monitored student
  had a one-click way to de-monitor their own device.
- The extension's toolbar icon and popup header showed a generic Chrome
  placeholder / shield emoji, since the manifest never declared any
  icons. Now shows ClassGuard's actual logo.
- A pre-existing Let's Encrypt cert (issued before the redirect feature
  above existed) would have sat in limbo for months before the redirect
  ever activated, since it only backfills on renewal; now backfills on
  every daily check regardless.
- The chrony NTP install script left `systemd-timesyncd` running alongside
  chrony and never actually installed its own client-activity reporter's
  cron job, even though it shipped the script in the same bundle.

---

## [0.3.0] - 2026-06-21

### Added

- **Persisted browser history** — tab-navigation events captured by the
  Chrome extension were only ever shown live on the teacher dashboard, with
  no durable record once the capped Redis stream filled. Now drained to a
  new `browser_history` table (same hypertable/compression/retention shape
  as `dns_logs`) every 5 seconds, with a new admin **Browser History** page
  (filter by student/URL/action/date, teacher-roster-scoped) and a deep
  link from each student's User Detail page next to DNS Logs.
- **Google profile photos** surfaced in the UI — `users.photo_url` was
  already being ingested from Workspace/Classroom sync and SSO login, but
  only ever rendered on Staff Analytics. Now shown (with a letter-circle
  fallback on load error, via a new shared `Avatar` component) on the Users
  list, User Detail, and the live-lesson student grid.
- **HA cluster generalized from 2 nodes to N nodes** — `nodes` now carries
  an explicit `failover_priority` per node instead of a hardcoded
  primary/secondary VRRP priority pair, so any number of servers can
  participate in the same priority-ordered election. Every node generates
  as VRRP `state BACKUP` with `nopreempt` (pure protocol-driven election,
  no hardcoded "MASTER" template); a recovered higher-priority node stays
  demoted until explicitly promoted back. The HA and RADIUS pages now show
  an editable, ranked failover order across every node instead of two fixed
  "primary priority"/"secondary priority" fields.
- **NTP server (chrony)** — ClassGuard's existing NTP page only ever
  monitored external time sources for dashboard health; it never served
  time to anything. Adds a real chrony-based server (every node runs it
  independently, no election needed — redundancy comes from DHCP handing
  out every node's IP), configurable upstream pool and allowed client
  subnets, with a generated config/install-script bundle per node.
- **Filter Simulator can test a specific policy directly** — previously it
  could only resolve the effective policy via the same student/network
  lookup chain real traffic goes through, with no way to check a policy's
  own rules in isolation (e.g. while still drafting one before assigning it
  to anyone). New mode toggle skips resolution and evaluates the chosen
  policy's domain/category/blocklist rules directly.

### Fixed

- DNS engine's TCP path logged the stringified `net.Socket` accessor
  function as a query's `source_ip` instead of the real client address
  (dns2 hands the TCP handler a raw socket, not a `{address, port}` dict
  like UDP gets) — and because that one malformed value poisons the whole
  batch insert, a single TCP-retried query could silently wedge the entire
  `dns_logs` drain for every device, not just the TCP one, until someone
  noticed the repeating error log.
- Kea DHCP had no `allocator` set, silently running Kea's unsafe iterative
  default against a Postgres lease table shared by multiple simultaneous
  HA-node instances with no `libdhcp_ha` hook — per ISC's own shared-lease-
  DB guidance this causes the same address to be double-offered to two
  clients. Set to `random`, which Kea 2.6.2+ (running 2.6.5) supports
  safely for this exact multi-instance setup.

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
