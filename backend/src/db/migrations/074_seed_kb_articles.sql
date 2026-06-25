-- Seed content for the Knowledge Base / Help Center, one article per
-- top-level admin/teacher page (see routes/knowledgeBase.js), written from
-- a direct analysis of each page's actual code. Ships with every install
-- so a fresh server has the same help content as this one, not just the
-- table structure. ON CONFLICT guards against a future re-seed colliding
-- with an admin's own edits to these slugs.
INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'dashboard', 'Dashboard', 'Overview',
  $kb$The landing page after logging in as an admin.

- **System status** — live backend health, which node you're on, and its version. Auto-refreshes every 60 seconds.
- **DNS stats** — total/allowed/blocked queries for the last 24 hours, plus a trend chart.

If System ever shows anything other than green "All systems operational," check **System Health** and **HA Cluster** before assuming the worst — that banner has had at least one real bug where it showed red while everything was actually fine (a routing gap meant the browser's health check never reached the backend over HTTPS).$kb$,
  ARRAY['/admin']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'staff-analytics', 'Staff Analytics', 'Overview',
  $kb$Teacher usage and classroom activity over the last 30 days — which teachers are actively running lessons, using Lockdown Tests, or managing Penalty Box, and how much of each student's school day is actually being monitored ("device activity").

This is an **adoption and coverage** view, not a moment-to-moment monitoring tool. For "what is this student doing right now," use Screen Time, DNS Logs, or Browser History instead.$kb$,
  ARRAY['/admin/staff-analytics']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'screen-time', 'Screen Time', 'Overview',
  $kb$Aggregated device and browser activity duration per student.

This is the same underlying data (`screen_time_intervals`) used by the on-demand **Parent Report**, generated from a student's page under Users. If you need a single document to hand to a parent rather than a live dashboard, generate that report instead of screenshotting this page.$kb$,
  ARRAY['/admin/screen-time']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'users', 'Users', 'Overview',
  $kb$The full directory of every account in ClassGuard — students, teachers, admins, and superadmins.

Accounts are normally populated by your Google Workspace / Mosyle / roster integration (see **Roster Sync** and **Integrations**), not created by hand here. Click into a user for their detail page: role, assigned policy, and — for students — a **Generate Parent Report** button covering screen time and flagged safety events for a date range you choose.

Role changes and granular admin permissions are managed from **Roles & Permissions**, not from this page.$kb$,
  ARRAY['/admin/users']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'policies', 'Policies', 'Policies & Safety',
  $kb$The actual content-filtering rule sets — what's allowed, blocked, or time-limited, and for whom. A policy is assigned to a **Group**, an individual user, or set as the district default.

- Supports an **on/off-campus split** — a policy can behave differently depending on whether the device is currently on the school network.
- Can be **bell-schedule-period aware** where period data has actually been entered (see Bell Schedule) — most districts haven't populated that yet, so most policies today are effectively always-on.
- Edits take effect at the DNS resolver almost immediately. There's no separate "publish" or "deploy" step.$kb$,
  ARRAY['/admin/policies']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'policy-simulator', 'Filter Simulator', 'Policies & Safety',
  $kb$Answers "would this URL be blocked for this student, right now" without visiting the site or waiting for a real query to show up in DNS Logs.

Useful for testing a policy change before rolling it out district-wide, or for explaining to a parent or teacher exactly why a site was (or wasn't) blocked, on the spot.$kb$,
  ARRAY['/admin/policy-simulator']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'groups', 'Groups', 'Policies & Safety',
  $kb$Named collections of students or devices — e.g. "Elementary," "Staff Laptops," "9th Grade" — that Policies, Blocklists, and other features assign to in bulk instead of one student at a time.

This is the unit of assignment used throughout the rest of the app. Create the group here first, then attach a policy (or other rule) to it from wherever that rule lives.$kb$,
  ARRAY['/admin/groups']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'blocklists', 'Blocklists', 'Policies & Safety',
  $kb$URL-based domain blocklists (e.g. Steven Black hosts, OISD) — large third-party lists of known-bad domains (ads, malware, adult-content aggregators) refreshed on a schedule, layered on top of your own Categories and Policies rules.

These exist for bulk coverage you don't want to maintain by hand; for anything specific to your district, use Categories or a per-policy exception instead.$kb$,
  ARRAY['/admin/blocklists']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'categories', 'Categories', 'Policies & Safety',
  $kb$Website taxonomy for DNS filtering — block, allow, or monitor by category per policy.

This is the building block **Policies** actually reference: a policy says "block Gambling, allow Education," not a literal domain list. Add or recategorize an individual domain here when a site is miscategorized or missing entirely. The AI Classifier page can help populate this for unknown domains, but isn't required to use it.$kb$,
  ARRAY['/admin/categories']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'screenshots', 'Screenshots', 'Policies & Safety',
  $kb$Safety evidence — keyword matches, proactive (non-text) risk-based captures, and teacher-requested captures — each scored by category and risk level, routed into a ticket-style review queue.

This is the queue staff actually triage day to day. **Safety Alerts** is the notification layer built on top of this data, not a separate source of evidence — configure who gets paged for a high-risk event from that page, not this one.$kb$,
  ARRAY['/admin/screenshots']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'browser-history', 'Browser History', 'Policies & Safety',
  $kb$Persisted page navigations reported by the Chrome extension — the raw per-student browsing trail, independent of whether anything was ever blocked or flagged.

Use this for "what did this student actually visit" look-backs. Use **DNS Logs** instead for "what did this network resolve" — DNS Logs also covers non-Chrome traffic and devices the extension isn't running on, which this page can't see at all.$kb$,
  ARRAY['/admin/browser-history']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'chat-audit', 'Chat Audit', 'Policies & Safety',
  $kb$Every message exchanged between staff and students in the in-app chat feature — including ones a participant later deleted.

Deletion only hides a message from the participants' own conversation view. It is never actually removed from this audit log.$kb$,
  ARRAY['/admin/chat']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'device-view-audit', 'Device View Audit', 'Policies & Safety',
  $kb$Every time an admin viewed a student's live browser feed or screenshots — append-only by design.

This exists specifically so "who looked at this student's screen, and when" is itself an auditable fact, including against another admin's account, not just something self-reported.$kb$,
  ARRAY['/admin/device-view-audit']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'impersonation-audit', 'Impersonation Audit', 'Policies & Safety',
  $kb$Every "View as this teacher" session — who started it, every change made while it was active, and when it ended.

Impersonation itself is started from a teacher's entry on the **Users** page, not here. This page is the read-only record of what happened during and after that session.$kb$,
  ARRAY['/admin/impersonation-audit']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'ai-classifier', 'AI Classifier', 'Policies & Safety',
  $kb$Classifies websites as educational, time-wasting, or productive using an AI model, to help populate **Categories** without manually triaging every unrecognized domain.

Optional — the rule-based safety-evidence scoring behind **Screenshots** does not depend on this being configured at all.$kb$,
  ARRAY['/admin/ai']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'safety-alerts', 'Safety Alerts', 'Policies & Safety',
  $kb$Configures who gets emailed (and paged in-app, via the red banner) when a safety event is flagged in **Screenshots** above a risk threshold.

Student-safety alerts go to this recipient list plus every currently logged-in staff member. This is intentionally a **different audience** than infrastructure/technical alerts (HA role changes, internet outages) — those only ever go to superadmins, since "a node just failed over" is meaningless noise to a building admin or teacher.$kb$,
  ARRAY['/admin/safety-alerts']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'filter-bypass', 'Filter Bypass Alerts', 'Policies & Safety',
  $kb$Detects a Chromebook on school WiFi that's generating **zero traffic through ClassGuard's own DNS filter** — the signature of a student having routed around the content filter entirely (switched DNS servers, tunneled, etc.). This check is independent of the Chrome extension, so it still catches a bypass even if the extension itself has been disabled.

Automatically excludes:
- Shared/kiosk/cart accounts (any "assigned" account mapped to more than one device)
- Staff accounts (only `role = 'student'` is checked)
- Devices not currently on school WiFi at all (there's nothing to observe on a network the system never sees)

Only runs during a configurable **active-hours window** (default weekdays 7am–4pm, editable right on this page) to avoid false positives from idle overnight/weekend devices. Requires two consecutive detections roughly 15 minutes apart before actually alerting.$kb$,
  ARRAY['/admin/filter-bypass']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'unblock-requests', 'Unblock Requests', 'Policies & Safety',
  $kb$Students and staff can request access to a blocked site directly from the block page. This is the admin queue for approving or denying those requests.

Approving a request here typically means adding an exception to the relevant policy or category — it isn't just a ticket-tracking dismissal.$kb$,
  ARRAY['/admin/unblock-requests']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'dns-logs', 'DNS Logs', 'DNS & Network',
  $kb$The raw per-query log of everything ClassGuard's DNS resolver has seen — every domain, every device, the allow/block decision, and why. Backed by TimescaleDB to handle high query volume (4M+ queries/day).

This is the most granular, lowest-level record in the system. Browser History, Filter Bypass Alerts, and several Reports are all effectively built on top of what this table captures.$kb$,
  ARRAY['/admin/dns/logs']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'dns-stats', 'DNS Stats', 'DNS & Network',
  $kb$Aggregated, pre-computed rollups of DNS Logs via a TimescaleDB continuous aggregate — trend lines and top-domain/category breakdowns without querying the full raw log.

Use this for "how is filtering trending overall." Use DNS Logs for "what happened with this one device."$kb$,
  ARRAY['/admin/dns/stats']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'dns-records', 'DNS Records', 'DNS & Network',
  $kb$Custom DNS records that ClassGuard's resolver answers directly — internal hostnames, overrides, and similar entries.

This is plain authoritative DNS, separate from filtering/blocking logic — it's about what a name resolves *to*, not whether a query is allowed.$kb$,
  ARRAY['/admin/dns/records']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'radius', 'RADIUS / NAC', 'DNS & Network',
  $kb$FreeRADIUS integration for WiFi authentication and network access control — which device or user is allowed onto which VLAN/SSID, independent of content filtering itself.

Participates in the same HA failover as the rest of the stack — a VRRP role change moves RADIUS service along with everything else.$kb$,
  ARRAY['/admin/radius']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'ipam', 'IPAM', 'DNS & Network',
  $kb$Full IP address management — **Subnets, VLANs, VRFs, Sections, BGP, NAT, Locations, Multicast**, plus a subnet **Calculator** and an **Activity** audit log, tabbed across the top of the page.

Think of this as the "plan and document the network" tool (in the spirit of phpIPAM). It's deliberately separate from **DHCP**, which is the page that shows what's actually being handed out right now by Kea — IPAM is the plan, DHCP is the live operational state.

Click into any subnet (Subnets tab) for its individual reservations and active leases. Bulk import of subnets or addresses from a spreadsheet is available from the same page.$kb$,
  ARRAY['/admin/ipam']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'dhcp', 'DHCP', 'DNS & Network',
  $kb$ISC Kea integration — subnets, reservations, and active leases exactly as Kea itself currently sees them.

IPAM is the planning and documentation layer for your address space; this page is closer to "what is actually being leased out right now." A subnet can exist in IPAM without yet having a matching Kea configuration, and vice versa — they're related but not the same data.$kb$,
  ARRAY['/admin/dhcp']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'network-infra', 'Network Infra', 'DNS & Network',
  $kb$Unified client view across UniFi, Meraki, Aruba, and Ruckus — every known device's access point, switch, and port, normalized into one list regardless of vendor.

This is also the data source **Filter Bypass Alerts** and the device-matching used by **Lost Mode** both read from to know whether a device is currently connected to school WiFi, and where.$kb$,
  ARRAY['/admin/network']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'phone-system', 'Phone System', 'DNS & Network',
  $kb$Manages the district's phone numbers and extensions, including bulk import via an Excel template.

This exists separately from every content-filtering and safety feature in the app — purely because IT in most districts also owns the phone system.$kb$,
  ARRAY['/admin/phones']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'roster-sync', 'Roster Sync', 'System',
  $kb$Auto-populates classes and rosters from Google Classroom, or your SIS via OneRoster, instead of building class lists by hand.

Run this whenever rosters actually change — semester start, schedule changes — rather than assuming it happens automatically unless you've specifically scheduled a recurring sync.$kb$,
  ARRAY['/admin/roster']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'bell-schedule', 'Bell Schedule', 'System',
  $kb$Defines the school day's period times, so other features can eventually reason about "is this 3rd period right now" rather than just wall-clock time.

As of this writing, no real period data has been entered here yet district-wide. Features designed to use it (like period-aware policy enforcement) fall back to a simpler always-on or business-hours check until this is actually populated.$kb$,
  ARRAY['/admin/bell-schedule']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'integrations', 'Integrations', 'System',
  $kb$Connect external systems — MDM, helpdesk, inventory, and IP management.

All credentials configured here live in the database and are editable from this UI, never in a `.env` file — specifically so they can be rotated by an admin without a deploy, and so a dedicated scoped service account can be swapped in over a personal one.

This is also where Google Workspace domain-wide delegation, Mosyle, and Snipe-IT are connected. Most device-facing features elsewhere (Lost Mode, the device matching behind Network Infra and Filter Bypass Alerts) depend on at least one of these being configured here first.$kb$,
  ARRAY['/admin/integrations']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'ha-cluster', 'HA Cluster', 'System',
  $kb$Multi-server cluster management — node list, VRRP role (MASTER/BACKUP), the shared floating IP, database replication lag, and scheduling a version update to push out to other nodes.

Failover uses `nopreempt`: once a backup node takes MASTER during a failover, a returning primary does **not** automatically reclaim the role just because it has a higher priority. Reclaiming MASTER requires an uncontested election window, not merely being back online — this was the cause of a real ~15-minute VIP role-flip incident, not a bug.$kb$,
  ARRAY['/admin/ha']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'vpn', 'VPN', 'System',
  $kb$Self-hosted IKEv2 VPN over the VRRP floating IP, for remote access into the district network.

Authentication trusts ClassGuard's own internal CA rather than a third-party identity provider.$kb$,
  ARRAY['/admin/vpn']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'ipv6', 'IPv6', 'System',
  $kb$For districts whose ISP doesn't offer native IPv6 — provides IPv6 connectivity via tunneling rather than requiring native upstream support.

If your ISP already provides native IPv6, you don't need this page at all.$kb$,
  ARRAY['/admin/ipv6']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'ntp', 'NTP', 'System',
  $kb$Time synchronization status for every configured NTP server, plus visibility into which devices on the network are actually polling ClassGuard's own chrony server for time.

Accurate clocks matter more than it sounds: TLS certificate validation, cross-node log correlation, and HA heartbeat timing all silently depend on every node and device agreeing on what time it is.$kb$,
  ARRAY['/admin/ntp']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'system-health', 'System Health', 'System',
  $kb$Live status and version for every service ClassGuard depends on (Postgres, Redis, the DNS engine, etc.), pinned to what's actually running right now — not what's supposed to be running.

Check this page (and HA Cluster's per-node version) before assuming a "Degraded" indicator elsewhere is real. Dashboard's own System banner has had a real bug before where it showed red for a routing reason that had nothing to do with actual backend health.$kb$,
  ARRAY['/admin/system-health']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'backup-restore', 'Backup & Restore', 'System',
  $kb$Encrypted export and import of the full system configuration, for migrating to new hardware or recovering from a lost server.

Restore is **fresh-server-only by design** — it's meant for standing up a replacement server, not for merging or rolling back state on a server that's already running and actively in use.$kb$,
  ARRAY['/admin/backup']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'security-scan', 'Security Scan', 'System',
  $kb$Runs `npm audit` against the backend's own dependency tree and surfaces anything with a known CVE, so a vulnerable dependency doesn't sit unnoticed for months.

Known gap: frontend build-tooling dependencies (e.g. Vite/esbuild, which only run at build time and are never shipped to a browser) aren't covered by this scan yet. That's a tracked limitation, not something silently ignored.$kb$,
  ARRAY['/admin/security-scan']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'reports', 'Reports', 'System',
  $kb$On-demand PDF reports for things that aren't just live filtering data — currently **IPAM utilization**, **DNS filtering summary**, and **device fleet health**, with more report types meant to be added to the same registry over time rather than each getting its own one-off page.

Every generated report is stored and can be re-downloaded later exactly as it looked when generated — re-running the same report type later will reflect the data as it is *then*, not retroactively change the older one.$kb$,
  ARRAY['/admin/reports']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'lost-mode', 'Lost Mode', 'System',
  $kb$Find and lock a lost or stolen Chromebook via the Google Admin SDK — disable or re-enable it remotely, and see its last known network info (access point/SSID) if it has one, via the same data Network Infra uses.

Two real limits worth knowing before relying on this:
- **No GPS or geolocation data** is exposed for ChromeOS devices by any Google API — this can tell you the last AP it was seen on, not a location on a map.
- The **lock-screen message is a single static, domain-wide setting**, configured once in Google Admin Console — this page can't customize the message per incident.$kb$,
  ARRAY['/admin/lost-mode']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'settings', 'Settings', 'System',
  $kb$District-wide configuration that doesn't have its own dedicated page — branding, the school name shown on the block page and on Parent Reports, and other system-level toggles (including, for example, Filter Bypass Alerts' active-hours window).$kb$,
  ARRAY['/admin/settings']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'roles-permissions', 'Roles & Permissions', 'System',
  $kb$Defines exactly which permission keys (Policies, Screenshots, Backup & Restore, etc.) a given admin has, layered on top of the fixed student/teacher/admin/superadmin role tiers — e.g. an admin who can see Screenshots but not Backup & Restore.

**Superadmin-only.** Granting a permission here is itself adjacent to privilege escalation, so it sits at the same access tier as changing someone's role outright.$kb$,
  ARRAY['/admin/custom-roles']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'my-classes', 'My Classes', 'Classroom',
  $kb$A teacher's own classes and lessons — start a live lesson, see which students are currently active, and jump into **Penalty Box** or **Lockdown Tests** for any of them.

Class rosters here are normally populated by **Roster Sync**, not built by hand.$kb$,
  ARRAY['/classes']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'penalty-box', 'Penalty Box', 'Classroom',
  $kb$Students with restricted internet access — placed here manually by a teacher, or automatically by a policy violation — limited to an allowlist (or nothing) until released.

This is a disciplinary/restriction tool. For a scheduled, assessment-specific lock instead, use **Lockdown Tests**.$kb$,
  ARRAY['/penalty-box']
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'lockdown-tests', 'Lockdown Tests', 'Classroom',
  $kb$Locks a class's devices to a single allowed site or app for the duration of a test, so students can't tab away to anything else.

Independent of **Penalty Box** — this is a deliberate, scheduled restriction for an assessment, not a disciplinary action, and is meant to be lifted automatically when the test window ends.$kb$,
  ARRAY['/lockdown']
) ON CONFLICT (slug) DO NOTHING;


