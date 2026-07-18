# Architecture Overview

A high-level map of how ClassGuard fits together. For per-feature usage, see the pages under each category in the sidebar.

## Components

ClassGuard runs as a set of Docker containers on each node, orchestrated by Compose:

- **API** — Node/Express backend (`/api/v1/*`). All policy decisions, integrations, and data access. Bound to the host loopback for internal callers; reached externally through the frontend proxy.
- **Frontend** — the React admin UI (Vite build) served by nginx, which also terminates TLS and reverse-proxies the API and websocket.
- **PostgreSQL** — primary datastore. In an HA pair, one node is the writable primary and the other a streaming replica.
- **Redis** — cache and the real-time event/log stream backbone.
- **DNS engine** — the network-level filtering resolver (bulk blocklists, category filtering, per-policy resolution).
- **FreeRADIUS** *(optional)* — network access control front-end; see [[RADIUS / NAC|RADIUS NAC]]. Runs on the host, driven by the API.

## Two filtering layers

ClassGuard filters at two complementary layers, split by what each does best:

1. **Network (DNS)** — bulk domain blocklists and category filtering for **every** device on the network, including ones that can't run an extension (tablets, TVs, personal phones).
2. **Browser (Chrome extension)** — in-browser enforcement for things DNS can't express: URL-path rules, per-video/category YouTube filtering, lesson whitelists, lockdown testing, and direct-IP bypass protection.

Neither is redundant; each closes the other's blind spots.

## High availability

Nodes form an active/standby cluster with a floating virtual IP. Keepalived (VRRP) holds the VIP on the healthy primary and fails it over if a tracked service (the API, FreeRADIUS) goes unhealthy. Postgres replicates primary→standby; the standby's database is read-only, so write-path jobs (schedulers, samplers) run only where the DB is writable. See [[HA Cluster|HA Cluster]].

## Deployment & updates

Each node self-updates from the repository on a schedule; a host-level watcher applies the update and reconciles generated config (firewall, FreeRADIUS, keepalived). See [[Deployment & Updates]].

## Data & privacy

Student browsing data (URLs, titles, optional screenshots) is reported by the extension to **your** ClassGuard server only — never to a third party. Screenshots are captured on trigger (policy flag, keyword match, or explicit staff request), not continuously. See [[PRIVACY|https://github.com/manderson20/classguard/blob/main/PRIVACY.md]] in the repository and the [[Screenshots]] and [[Browser History]] pages.

---
_[[Home]] · ClassGuard Help Center_
