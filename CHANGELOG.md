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

## [0.7.31] - 2026-06-24

### Added
- **Encrypted configuration backup & restore** (new "Backup & Restore" page). Export a passphrase-encrypted file containing this district's policies, settings, roster, network/DHCP/RADIUS/phone config, and integrations — for moving to new hardware or just keeping a safe copy. Deliberately excludes activity history (DNS logs, browser history, chat, audit trails) and cluster topology, which don't belong in a "move my configuration" backup. AES-256-GCM encryption (fails closed on a wrong passphrase or corrupted file, never silently returns garbage); the cleartext header (created date, ClassGuard version, table list) lets you confirm you're restoring the right file before being asked for the passphrase. Restore is superadmin-only and intended for a freshly-installed, empty server — it deletes then re-inserts every covered table inside one transaction, so a server that already has activity history referencing existing records fails cleanly with a foreign-key error (by design) rather than silently destroying that history. Export is delegable via a new `backup_export` permission. Tested end-to-end against a fully disposable Postgres+Redis instance (never against real district data) including a full restore with row-for-row data verification.

---

## [0.7.30] - 2026-06-24

### Added
- **"Unique blocked domains" view on DNS Query Logs.** A workflow shortcut for triaging what's actually getting blocked — same filters as the existing per-query log (which is unchanged and still the default), but collapsed to one row per domain, sorted by how often it was blocked, with first/last seen and the most recent block reason. Each row keeps the existing "+ Allow" action and domain resolve-lookup, so working through the list to decide what needs to be allowed doesn't require scrolling past hundreds of rows for one popular site. New `GET /dns/logs/unique-domains` endpoint.

---

## [0.7.29] - 2026-06-24

### Added
- **Pagination on the Users page.** `GET /users` was previously unbounded — fine at a few hundred accounts, but a large district can have 40-50k users, which meant one multi-MB JSON response and an unvirtualized table trying to render all of it at once. Now paginates 50/page with Previous/Next controls, capped at 500/request server-side (matching what the policy student-picker dropdowns on Policy Simulator/Policy Editor already request). Response shape changed from a bare array to `{ users, total }`; the one other caller of this endpoint (RADIUS policy's user-search) updated to match.

---

## [0.7.28] - 2026-06-24

### Added
- **Teacher impersonation ("View as this teacher").** Admins can now temporarily view ClassGuard exactly as a specific teacher sees it — their classes, penalty box, lockdown tests — to troubleshoot on their behalf without needing the teacher's password. New "View as this teacher" button on a teacher's profile (Users > teacher > View) opens a 30-minute session; a persistent purple banner shows who's impersonating and lets them exit at any time, returning to the original admin session. Every session start/end and every change made while impersonating is recorded in a new append-only `impersonation_audit` table (migration 069), visible on a new Impersonation Audit page. Restricted to teacher accounts only (not other admins/superadmins) and gated by a new delegable `impersonate_users` permission — superadmins always have it, admins need it explicitly granted via Custom Roles. Impersonation tokens can't be refreshed/extended past their 30 minutes; ending and re-starting is required, so there's always a bounded, re-confirmed window rather than an indefinite one.

---

## [0.7.27] - 2026-06-24

### Added
- **DNS cache hit rate on DNS Statistics.** New "Cache Hit Rate" card shows what fraction of allowed queries were served from dns-engine's existing Redis response cache vs. required a real upstream lookup, over the same time window (1h/24h/7d/30d) as the rest of the page — previously this was invisible; the cache itself has always been there (Redis, TTL from the real upstream response capped by Settings > DNS & Retention's "DNS Cache TTL"), there was just no way to see it working. New `cache_hit` column on `dns_logs` (migration 068), threaded through dns-engine's resolver → ring-buffer logger → Redis stream → scheduler drain, the same path every other DNS log field already takes — no new infrastructure, just one more fact recorded per query.

---

## [0.7.26] - 2026-06-24

### Added
- **Server resource usage on the System Health page.** New "Server Resources" section shows CPU load, memory, and disk usage for this node and every other known cluster node — so you can tell if a server is close to or exceeding capacity, not just whether services are up. Color-coded gauges (green/amber/red at 70%/90% thresholds). New `GET /system/resources` endpoint; disk usage (previously not collected anywhere) added via a small shared `systemResources.js` helper, reused by `/metrics` so Zabbix gets the same numbers — including two new triggers in the generated Zabbix template (disk above 90%, sustained CPU load above 90% for 5+ minutes). Cross-node resource fetching reuses the existing Zabbix metrics token (auto-generated now if one doesn't exist yet) rather than `INTERNAL_SECRET`, which is deliberately node-local and never synced across the cluster — the token works because it lives in the `settings` table, which already replicates HA-wide.

---

## [0.7.25] - 2026-06-24

### Added
- **Send test email from Settings > Communications.** Verify the mail server (SMTP) configuration works by sending a real test email to any address, right after configuring it — instead of only finding out it's broken when a real Safety Alert tries to fire. New `POST /settings/smtp/test` endpoint (gated by the same `settings` permission as the rest of the SMTP config), separate from Safety Alerts' existing test (which sends to the configured alert recipient list specifically) since this tests the mail relay itself.

---

## [0.7.24] - 2026-06-24

### Fixed
- **Bell Schedule: no explanation when a schedule can't be deleted.** The default schedule's "Set as default"/"Delete" buttons were simply hidden with no explanation when viewing it — if it was also the *only* schedule (e.g. after promoting a new schedule to default and deleting the original default), there was no way to tell why, or what to do about it. Now shows an explicit notice: the default schedule can't be deleted while it's the default (there must always be a fallback), and explains the fix — set a different schedule as default first, creating one if needed. Also surfaces a real error message if a set-default/delete request ever fails for any other reason, instead of failing silently.

---

## [0.7.23] - 2026-06-24

### Added
- **Multiple bell schedules.** Bell Schedule now supports more than one schedule district-wide — e.g. a Middle School split across two staggered schedules for hallway capacity — instead of assuming every student follows the same period times. Create as many named schedules as needed, each with its own periods (period labels can repeat across schedules with different times). Assign a schedule to a group of students via **either** their Google OU (longest-prefix match, same pattern Policies already uses) **or** their OneRoster-synced grade level (exact match) — never both at once; a district-wide toggle picks one matching strategy so there's always exactly one unambiguous answer for which schedule a student follows. Anyone with no matching assignment falls back to a designated default schedule. New `bell_schedules` and `bell_schedule_assignments` tables, `bell_schedule_periods` now scoped per-schedule (migration 067). The nightly teacher-period-utilization batch job now resolves each enrolled student's own schedule individually rather than assuming one global set of period times, so utilization reporting stays accurate for a Middle School (or any district) running more than one schedule. Building/school-level matching isn't supported yet — OneRoster doesn't sync that data into ClassGuard today, which would be new sync work, not just a new matching rule.

---

## [0.7.22] - 2026-06-24

### Added
- **Built-in roles unified with the custom permission system.** Super Admin, Admin, and Teacher are now real rows in the roles table instead of hardcoded strings with no manageable permission set. Super Admin is locked — always has every permission, can't be edited or weakened, so there's always a guaranteed full-access account. Admin defaults to every permission (matching today's behavior) but is now editable, so a district can narrow what admins can do. Teacher gets a real, editable row too, ready for teacher-specific permission keys as they're added (none exist in the catalog yet, so its checkbox grid starts empty). Existing admin/teacher/superadmin users were backfilled to point at the matching built-in role; anyone already on a custom role keeps it. New `is_builtin`/`is_locked`/`base_role` columns on `custom_roles` (migration 066); built-in roles can't be deleted or renamed, and the locked one rejects permission edits outright. The local-user-creation and per-user role dropdowns are now one unified picker sourced from the real roles list (built-in + custom) instead of four disconnected hardcoded strings — picking a role now actually assigns its permission set.

---

## [0.7.21] - 2026-06-24

### Added
- **Domain-based Wi-Fi policies.** Wi-Fi Policies (RADIUS / NAC) can now target an email domain in addition to a specific user or group — e.g. allow `@school.org` staff but deny `@students.school.org` on a given SSID. Domain rules are checked in `/radius/authorize` *before* the existing per-user lookup, independent of whether that account is even synced into ClassGuard's own Users table — a district that hasn't (or never will) sync students into Users still gets a real, explicit deny decision rather than an accidental pass-through that could start working the moment sync coverage changes. Per-SSID by design (a domain rule requires an SSID, same safety rule the existing default/catch-all policy already followed) and exact-domain matching — `students.school.org` and `school.org` are treated as distinct domains, not a subdomain wildcard. New `email_domain` column on `radius_user_policies` (migration 065); rejections at this stage now log to the Auth Log the same way the existing per-user/group rejections do (previously didn't log at all before reaching `/authenticate`).

---

## [0.7.20] - 2026-06-24

### Fixed
- **LDAP search-then-bind (v0.7.19) failed with `stringToWrite must be a string`.** `ldapjs` v3's `SearchEntry.objectName` getter returns a `@ldapjs/dn` `DN` *object* instance, not a plain string — `searchUserDn()`'s `entry.objectName || entry.dn?.toString()` let that object through un-stringified whenever `objectName` was truthy (which it always was), and passing it on to `bind()` broke downstream. Confirmed live against a real Workspace directory with a deep, multi-level OU structure (several sub-OUs nested under the top-level Users OU) — meaning the old hardcoded-DN approach this replaced in 0.7.19 was already broken for most real accounts, not just a hypothetical edge case. Fixed by forcing `String(...)` on whatever `objectName`/`dn` returns, once, rather than relying on truthy-object short-circuiting to coerce correctly.

---

## [0.7.19] - 2026-06-24

### Fixed
- **Google Secure LDAP authentication only ever worked for one bind DN/OU structure.** `radiusLdap.js`'s `authenticateUser()` guessed a fixed `uid=<email>,ou=Users,<base_dn>` bind DN, which breaks the moment a district's Workspace org separates students and staff into different OUs — exactly the situation a district with e.g. `@school.org` staff and `@students.school.org` students in one Workspace org runs into. Replaced with search-then-bind: search the whole base DN (subtree scope, `mail=<email>` filter) for the user's real DN first, using the same cert-authenticated connection Google's "Read user information" permission already authorizes, then bind as whatever DN that search actually returns to verify the password. Works for any domain/subdomain/OU combination in one Workspace org through the one LDAP connection — no per-domain config needed.
- **"Test Connection" failed with `self-signed certificate` even with valid Google-issued client cert/key.** Root cause: the LDAP connection wasn't sending SNI (Server Name Indication), so Google's front end returned its own diagnostic fallback certificate (`CN=invalid2.invalid`, "No SNI provided — please fix your client") instead of `ldap.google.com`'s real, legitimately-issued certificate chain — which then correctly failed validation as self-signed. Fixed by explicitly setting `servername: 'ldap.google.com'` on both TLS connections (ldapjs doesn't derive this from the connection `url` on its own).

### Added
- Moved Google Secure LDAP setup from RADIUS / NAC → HA & Config (where it never conceptually belonged — it's a Workspace-level credential, not a VRRP/failover setting) to Integrations → Google Workspace → Secure LDAP, alongside the other Google connections it's a sibling of. RADIUS page now links to its new home.
- New status card replacing the old wizard-only flow: shows at a glance whether LDAP is configured/enabled/actually connecting right now (auto-tests on page load, not just on a button click), with one-click enable/disable and re-test. New "Test a real login" form lets an admin verify any specific account (any domain/OU) authenticates correctly — credentials are typed directly into ClassGuard's UI and never appear in chat, logs, or storage; the password is discarded immediately after the one verification call. New `POST /radius/ldap/test-user` backend endpoint backs this, calling the exact same `authenticateUser()` FreeRADIUS uses in production.

---

## [0.7.18] - 2026-06-24

### Fixed
- **install.sh could silently skip steps after a self-update.** `git pull --ff-only` in Step 0 can rewrite `install.sh` itself while this same process is still executing it; bash doesn't re-read a running script as it goes; it keeps reading from its buffered position in the *old* file, which after a pull that changes file size/content lands on arbitrary wrong bytes in the *new* file rather than continuing in logical order. Confirmed live: this is exactly what happened on classguard2's first run after 0.7.17 added three new install steps — it pulled successfully, rebuilt the containers correctly (hence reporting the right version), but silently jumped from "Step 7 — Health check" straight to whatever ended up at the old "Step 8" byte offset, skipping the new firewall/keepalived/chrony/FreeRADIUS steps entirely. Now re-execs the freshly-pulled script immediately after a real pull, so everything after that point is guaranteed to come from the file actually on disk, read from the start.

---

## [0.7.17] - 2026-06-24

### Added
- **FreeRADIUS deployment automation**, completing the `track_freeradius` flag that VRRP health-checking already relied on (see 0.7.16) by actually deploying the service it was supposed to be tracking. New `GET /radius/freeradius-sync` (self-scoped, same trust boundary as `/ha/vrrp-sync`) returns this node's clients.conf/rest/eap/virtual-server config, generated from the real NAS list and the node's own `INTERNAL_SECRET`. New `infrastructure/freeradius/sync-freeradius.sh` installs FreeRADIUS if missing, deploys config, generates the EAP TLS certificate once (never rotated automatically — a rotating cert would invalidate already-trusted device profiles for no reason), and restarts only on a real change. Runs on every node, not just the primary, since the VIP can land on any of them. `/ha/firewall-rules` now opens 1812/1813 udp whenever `track_freeradius` is on. Wired into `install.sh` as Step 8d.
- Fixed four FreeRADIUS config-generation bugs in `services/keepalived.js` that had never actually been tested against a real `freeradiusd` until this deployment: an `rlm_rest` module referencing an empty/unreachable `${..tls}` block (removed — these calls are plain HTTP to localhost, TLS settings were never applicable), a single-line `cache { ... }` block FreeRADIUS's parser rejects without commas (reformatted to one setting per line), an unlang condition comparing `Tunnel-Type` as a quoted string instead of FreeRADIUS's required bare enum value (`== VLAN`, not `== 'VLAN'`, and needs the `&` attribute-reference prefix), and a doubled `${cadir}/certs/...` path (`${cadir}` already points at the certs directory).

### Fixed
- Corrected the 0.7.16 changelog entry below — the keepalived comment-stripping safety fix did *not* fully prevent a live incident as originally written here. It correctly avoided false-positive restarts, but a **genuine** config change (a `failover_priority` edit) still triggered a real restart on the live VRRP MASTER, which combined with a separately pre-existing, stale `track_freeradius` health-check penalty to cause an actual ~15 minute VIP role flip (classguard-1 lost MASTER to classguard2). Fully diagnosed and resolved same day — see `project_state_vrrp_nopreempt_incident` in project memory for the full writeup; the short version is `nopreempt` means a priority fix alone never reclaims MASTER, only a genuinely uncontested election does.

---

## [0.7.16] - 2026-06-24

### Added
- **Automated VRRP/keepalived and NTP server (chrony) sync**, extending the same pattern as v0.7.15's firewall automation to the other two host-level config bundles that were previously manual download-and-deploy-yourself steps. New `GET /ha/vrrp-sync` (this node's own rendered keepalived.conf + notify.sh, self-scoped rather than the admin-facing all-nodes bundle) and `GET /ntp/server-sync` (chrony.conf, identical on every node — no leader-election concept there). New `infrastructure/keepalived/sync-keepalived.sh` and `infrastructure/chrony/sync-chrony.sh`, both no-op entirely unless actually configured (a real VIP / the NTP server feature switched on), run once during install.sh and every minute by the update-watcher. `/ha/firewall-rules` now also opens 123/udp when the NTP server feature is enabled.

  Both sync scripts deliberately normalize away comments and whitespace before deciding whether to restart anything — the config generators embed a live timestamp plus other comment text that can drift between versions without anything *functional* changing, and restarting keepalived on a false-positive diff risks an actual VRRP role flip on the live MASTER (a brief advertisement gap during restart can let a BACKUP node grab MASTER, and `nopreempt` means the original node won't automatically reclaim it afterward). **Correction (see 0.7.17 above): this normalization worked exactly as intended, but didn't prevent every restart — only cosmetic-only ones. A real config change still restarts the service, and on this node's first real one, that exposed a separate pre-existing issue that caused an actual ~15 minute live VRRP role flip.**

---

## [0.7.15] - 2026-06-24

### Added
- **Automated firewall setup and ongoing sync**, closing the gap where every `ufw`/`fail2ban` rule applied earlier this session was entirely manual and one-time, with nothing keeping it current as the cluster changes. New `GET /ha/firewall-rules` computes the correct rule set for whoever calls it based on its actual role (DHCP/VPN ports only ever appear for a primary, and VPN specifically only if `vpn_config.enabled` is true — standbys never run Kea/VPN at all per `install.sh`) and live cluster membership (the Postgres-allow list is built from whichever standby IPs are *currently* active, pulled from `nodes.api_url` since `nodes.ip` is just an unused placeholder). New `infrastructure/firewall/sync-ufw.sh` installs `ufw`+`fail2ban` if missing and reconciles rules to match — added once during `install.sh` (new Step 8) and re-run every minute by the existing host-level update-watcher, so a 3rd node joining (or one leaving) updates the primary's Postgres firewall rule automatically within a minute, with zero manual SSH access required. The VPN status port (9999, unauthenticated) deliberately never appears in the generated rule set under any role/config combination.

---

## [0.7.14] - 2026-06-24

### Added
- **Automatic database promotion for HA failover**, opt-in and off by default. Previously, a VRRP failover moved the floating IP automatically but left the standby's Postgres read-only until an admin manually clicked "Promote to Primary" — every write would 500 until someone noticed and acted. A standby now auto-promotes itself once it has held VRRP MASTER *and* independently confirmed the old primary is unreachable, continuously, for a configurable grace period (default 5 minutes). With 3+ nodes, "confirmed unreachable" requires a quorum vote from the other nodes (`GET /ha/can-reach-primary` on each), not just this standby's own view of the network — a 2-node cluster has no quorum to take and falls back to that standby's own judgment alone, which the new HA page warning calls out explicitly as meaningfully less safe (a one-sided network partition is indistinguishable from a real primary failure with only two nodes). Fires a superadmin-only in-app banner + email (new `role:superadmin` socket room, deliberately separate from the general safety-alert recipient list — this is an infra event, not a student-safety one) so an admin can check for split-brain before trusting both copies still agree.

---

## [0.7.13] - 2026-06-24

### Fixed
- **nginx upstream resolution bug that silently 502'd every API call after a backend rebuild.** `frontend/nginx.conf` proxied to `api`/`scep` as a literal hostname, which nginx resolves once at config load and caches forever — since `classguard-api` gets a new container IP every time it's recreated (the normal `docker compose build && up -d` update flow), any update would 502 the entire admin UI, all socket.io connections, and cross-node HA heartbeats until something incidentally also reloaded nginx. Found live in production. Converted every `api`/`scep` proxy_pass to nginx's `resolver` + variable pattern (matching the existing fix already in place for `scep`) so the upstream re-resolves per-request instead of caching indefinitely. Along the way, hit and fixed nginx's well-known variable-`proxy_pass` gotcha (it drops the original request path entirely unless explicitly told to forward `$request_uri`, or for the `/scep/` prefix-stripping case, `$uri$is_args$args` after an explicit `rewrite ... break`) — first attempt at the fix silently broke every proxied route in a different way before this was caught and corrected.
- **VPN client certificate enrollment (SCEP) crash-looping with "PEM decode failed".** `node-forge`'s PEM encoder emits strict RFC 1421 CRLF line endings; strongSwan's parser (the VPN container) tolerates that, but the SCEP server's Go-based PEM parser doesn't, so the container never came up once SCEP was actually enabled. `backend/src/services/ca.js`'s `generateCa()` now normalizes to LF before returning; the already-generated CA already in this deployment's database was normalized in place (same CA identity/fingerprint, just fixed line endings — safe since no devices had enrolled yet).

---

## [0.7.12] - 2026-06-24

### Added
- **Firewall / Ports Reference on the HA page**, built after manually hardening classguard-1's host firewall (ufw + fail2ban) surfaced that nothing documented which ports are pure LAN traffic between cluster nodes vs. which need forwarding through the district's edge router. New section on `HaPage.jsx`: a LAN-internal table (VRRP protocol 112, Postgres replication restricted to the peer node, inter-node HTTP) and a router/edge table (VPN IKEv2 ports, conditionally required TCP 80/443 for off-campus extension sync), plus an explicit "do not forward" list (SSH, Postgres, DNS, DHCP). Pulls live values (VIP, peer node, VPN enabled, TLS validation method) rather than hardcoding them — caught and fixed a real bug during verification where the page asserted "DNS-01, no port forwarding needed" unconditionally, when this deployment is actually configured for HTTP-01 (which *does* require forwarding 80/443) — the TLS note is now conditional on the real configured `provider`.

---

## [0.7.11] - 2026-06-24

### Added
- **Local-password account management (superadmin-only)**, closing a real continuity gap found while setting up a test account: `POST /api/v1/auth/setup` only ever works once (fails with 409 the instant any user exists), and there was no other route anywhere to create a user or set/reset a password. In practice this meant only the single original setup account could ever log in without Google Workspace SSO — any outage or misconfiguration there, and there'd be no way in besides that one account. New `POST /api/v1/users` (create a local-password account, any role) and `PUT /api/v1/users/:id/password` (set/reset a password on *any* existing user, including Google-synced ones, as an SSO-outage fallback) plus matching UI: "+ Add Local User" on the Users page, "Set / Reset Local Password" on a user's detail page. Password hashing extracted from `auth.js` into a shared `services/passwordHash.js` so login, setup, and these new routes can never drift apart.

---

## [0.7.10] - 2026-06-24

### Changed
- **Sidebar Admin/Teacher switcher is now a dropdown** instead of a fixed two-button toggle (`NAV_VIEWS` array in `Layout.jsx`). Purely a control-rendering change — `cg_nav_view` localStorage persistence and the admin/teacher nav-switching logic are unchanged. Adding a future view down the line (e.g. a counselor- or IT-focused nav) is now a one-line addition to `NAV_VIEWS` plus its own nav-section condition, rather than a layout rewrite.

---

## [0.7.9] - 2026-06-24

### Changed
- **Reorganized Settings > Safety Alerts**, which had mixed three unrelated concerns under one tab: the SMTP mail relay connection (reusable infra), who receives an urgent alert + the test-send button (an application-level policy decision), and Flagged Keywords (a content-filtering feature, not a server setting). Split into:
  - **Settings > Communications** — just the mail server connection (host/port/TLS/user/password/from). Settings now only covers true server/infra config.
  - **New "Safety Alerts" page** (Policies & Safety nav, new `safety_alerts` permission key) with two tabs: **Flagged Keywords** (moved as-is) and **Alerting** (recipient list + send-test-alert, moved as-is).
  - Re-gated the four keyword-management routes and added dedicated `GET/PUT /settings/safety-alert-recipients` endpoints under the new `safety_alerts` permission, instead of leaving them on the generic `settings` permission — otherwise a custom role granted only the new page wouldn't actually be able to load or save anything on it (RBAC gap closed before it ever shipped). `safety_alert_emails` removed from the generic `/settings` endpoint's allowed-keys list since it now has its own narrower-scoped route.

---

## [0.7.8] - 2026-06-24

### Added
- **Basic upstream internet/DNS connectivity monitoring**, for districts without a separate NMS (Zabbix etc.) who still want a quick answer to "is it our DNS, or the internet connection itself" without digging through container logs. Built after this same session's real incident where this host's own outbound DNS to api.github.com was intermittently failing with no record of it anywhere. Every 2 minutes, checks (1) DNS resolution of a real domain through the actual configured upstream resolvers (same servers/failover order dns-engine itself uses) and (2) raw TCP connectivity to fixed public IP literals (1.1.1.1 / 8.8.8.8), deliberately bypassing DNS entirely — separating "DNS is broken" from "the whole internet connection is down." History (90-day retention) and current status surface as a small widget on the Admin Dashboard, gated by a new `internet_monitoring` permission key (unrestricted by default, same as every other admin-tier feature). Three consecutive failures (~6 min) triggers a staff-wide in-app banner + best-effort email (reusing the safety-alert SMTP pipeline); a matching recovery notice fires once the streak clears. Streak detection is derived from the persisted history rather than in-process state, so it survives the frequent API restarts this dev-style host does. New migration 064 (`internet_health_checks`).

---

## [0.7.7] - 2026-06-24

### Fixed
- **A transient DB connection blip could crash the entire API process.** The HA split-brain probe in `startHeartbeat()`'s 30s timer queried `nodes` for peer URLs with no `.catch()` guard, unlike every other query in that function. A `setInterval` callback has no error boundary the way an Express route handler does, so an unhandled rejection there terminates the whole Node process — confirmed live: a single `pg-pool` "Connection terminated due to connection timeout" crashed the API and it stayed down for over an hour, since `node --watch` does not auto-restart after a crash exit (only on a watched file change). Added the same `.catch()` fallback every sibling query in this function already has. Found and fixed by restarting the live, down API and root-causing the crash log.

---

## [0.7.6] - 2026-06-23

### Fixed
- **One malformed DNS log or browser-history record could silently halt that entire stream forever.** `insertDnsLogBatch`/`insertBrowserHistoryBatch` insert a whole drain cycle's records in one `unnest()`-based statement — a single bad value (e.g. an invalid UUID) fails the *entire* batch, and since the drain only advances its Redis stream cursor after a successful insert, the same bad batch would retry identically every cycle, blocking every record behind it indefinitely with no skip path. Both functions now fall back to inserting one record at a time on a bulk-insert failure — every good record still lands, and only the genuinely malformed one gets logged (full record content + error) and dropped, not retried again. Verified live against the real `classguard:dns-log` and `classguard:tab-events` streams with one good + one deliberately malformed record each: good record landed, bad one logged and skipped, real production traffic continued draining normally throughout.

---

## [0.7.5] - 2026-06-23

### Fixed
- **EXTENSION_SIGNING_KEY never synced when a node joins the HA cluster.** Same class of bug as v0.7.3's `JWT_SECRET` fix. This key is optional (only set if an admin has ever run the one-time `generate-key.js` keygen) but when it is set, every node needs the identical value or `extension-builder` mints a different Chrome extension ID on that node, silently forking the auto-update story between nodes the moment anyone builds the extension there. `/join` now hands it back alongside `JWT_SECRET` when present, and `/join-cluster`'s generated setup script patches it into the joining node's `.env` (using a `#`-delimited `sed`, since unlike `JWT_SECRET`/`DB_PASSWORD` this is full unfiltered base64 and can contain `/`) and restarts `extension-builder`. Fixes future joins only.

---

## [0.7.4] - 2026-06-23

### Fixed
- **A custom-role-restricted admin could still create/edit/delete any class district-wide.** `classes.js`'s admin-tier `POST/PATCH/DELETE /` sit on top of a `requireMinRole('teacher')` blanket gate (reachable only via the Teacher-nav view, which any admin/superadmin can switch into) and had no permission key in the custom RBAC system shipped in v0.7.0 — there's no dedicated Admin nav item for class management, so it was missed. Added a `classes` permission key and gated all three routes with `requirePermissionIfAdmin`. Also fixed an unrelated pre-existing bug found while verifying this: `POST /classes` referenced a column (`google_course_id`) that's never existed — the real column is `google_classroom_id` — so creating a class via this API has been silently 500ing regardless of permissions.

---

## [0.7.3] - 2026-06-23

### Fixed
- **JWT_SECRET was never synced when a node joined the HA cluster.** Every node independently generates its own `JWT_SECRET` at install time (`install.sh`), and the join flow (`/ha/join`, `/ha/join-cluster`) already syncs `DB_PASSWORD` the same way for Postgres replication — but never extended that to `JWT_SECRET`. Net effect: a session minted on the primary was never actually valid on a standby, so every logged-in user got silently bounced to the login screen the moment VRRP failed over. `/join` now hands back the primary's `JWT_SECRET` unconditionally (not gated behind requesting DB replication), and `/join-cluster`'s generated setup script patches it into the joining node's `.env` and restarts its `api` container. This fixes future joins only — nodes that already joined before this fix need a one-time manual `.env` sync.

---

## [0.7.2] - 2026-06-23

### Fixed
- **VRRP auth password leaked in plaintext via the HA/RADIUS config API.** `GET/PUT /api/v1/ha/vrrp` and `GET/PUT /api/v1/radius/ha` both returned `vrrp_auth_password` in the raw JSON response, and the HA Cluster and RADIUS pages pre-filled it directly into a password input. Found while wiring Settings ▸ Monitoring to the same endpoint for the v0.7.1 Zabbix fix. Now redacted (`vrrp_auth_password_set` boolean instead) using the same pattern already used for TLS provider credentials; "leave blank to keep" continues to work since omitted fields were already handled correctly on write. Config-bundle download endpoints (which generate the actual `keepalived.conf`) are unaffected — they still need and return the real value.

---

## [0.7.1] - 2026-06-23

### Fixed
- **Zabbix monitoring didn't account for the HA/VRRP cluster.** The `/metrics` endpoint and its generated Zabbix template predated the N-node HA work and treated ClassGuard as a single box — polling only the VIP can never reveal a failover, since the VIP always answers as whichever node currently holds MASTER. `/metrics` now reports each node's own VRRP role (`vrrp_state`, `is_vrrp_master`, `failover_priority`), and the generated Zabbix template creates one host per cluster node *plus* one for the VIP (pulled live from the `nodes` table, so it generalizes to however many nodes are in the cluster), with a trigger per node on VRRP-role-changed and a cluster-wide split-brain trigger if more than one node ever reports MASTER at once. Settings ▸ Monitoring now lists every node's metrics URL instead of a single guessed endpoint.

---

## [0.7.0] - 2026-06-22

### Added
- **Custom permissions/roles for admin-tier users.** Previously every `admin`-role account had access to the entire admin surface — no way to give a front-office/help-desk staffer just Users + Unblock Requests without handing them Network, DHCP, VPN, and Settings too. Superadmins can now create named roles (Roles & Permissions, superadmin-only) bundling any combination of ~27 feature-area permissions, and assign one to any admin-tier user from the Users page. A user with no custom role assigned keeps full, unrestricted access — today's default behavior, unchanged. Role assignment, HA promote/VRRP, VPN CA/key material, TLS issuance, and other infrastructure-control endpoints remain hardcoded superadmin-only and are never delegatable through this system. `superadmin` itself is always fully unrestricted.

---

## [0.6.12] - 2026-06-22

### Added
- **Teacher Live View Phase 5** (final phase): Admin/Teacher nav switcher. Admins and superadmins who also teach a class previously had no way to reach the classroom-only sidebar (My Classes / Penalty Box / Lockdown Tests) — only plain `teacher`-role accounts saw it. Added a segmented Admin/Teacher toggle to the sidebar (admin+ only) that swaps which nav renders, persisted per-browser. Purely a navigation switch — underlying data access is unchanged either way.

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
