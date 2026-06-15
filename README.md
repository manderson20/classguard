# ClassGuard

> Open-source school internet safety and classroom management platform — a self-hosted alternative to GoGuardian built for Google Workspace for Education districts.

[![Version](https://img.shields.io/badge/version-0.0.1-blue)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-AGPLv3-green)](LICENSE)
[![CI](https://github.com/manderson20/classguard/actions/workflows/ci.yml/badge.svg)](https://github.com/manderson20/classguard/actions/workflows/ci.yml)

---

## What ClassGuard Does

| Feature | Description |
|---------|-------------|
| DNS Filtering | Block inappropriate content district-wide via on-server DNS + DNS-over-HTTPS for off-network devices |
| DHCP Management | ISC Kea DHCP server managed through the Admin UI — subnets, reservations, live lease table |
| Per-Student Policy | Apply filtering rules to individuals, groups, OUs, or the entire district |
| Penalty Box | Lock a student to an explicit allow-list only |
| Lesson Mode | Teachers restrict a class to a defined set of sites during a lesson |
| Screen Monitoring | Teachers view student screens in near-real-time from a web dashboard |
| Classroom Control | Lock screens, close tabs, push URLs, send messages to students |
| Google Integration | SSO via Google OAuth; sync users, OUs, and groups from Google Admin |
| CIPA Compliance | Satisfy CIPA requirements with configurable blocklist subscriptions |
| High Availability | Multi-node DNS + DHCP failover following corporate network best practices |

Covers: **Chromebooks**, **managed Macs**, and **iPads**.
No per-seat licensing. Runs on your own Ubuntu server or Docker stack.

---

## Architecture at a Glance

```
Clients (Chromebook / Mac / iPad)
         |                    |
   DNS port 53          DoH (HTTPS /dns-query)
         |                    |
    ┌────▼────────────────────▼────┐
    │        ClassGuard Node(s)    │
    │                              │
    │  Nginx (443/80)              │
    │  ├── React SPA (Admin/Teacher UI)
    │  ├── Node.js API + Socket.io │
    │  ├── DNS Engine (port 53)    │
    │  └── ISC Kea DHCP (port 67) │
    │                              │
    │  PostgreSQL · Redis          │
    └──────────────────────────────┘
```

See [`imageref/ClassGuard-Specification.md`](imageref/ClassGuard-Specification.md) for the full specification.

---

## Quick Start (Docker)

```bash
# 1. Clone the repository
git clone https://github.com/manderson20/classguard.git
cd classguard

# 2. Configure environment
cp .env.example .env
# Edit .env — set DB_PASSWORD, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_DOMAIN, etc.

# 3. Start all services
docker compose up -d

# 4. Run database migrations (first run only)
docker compose exec api node src/scripts/migrate.js

# 5. Build and serve the frontend
docker compose run --rm frontend
docker compose restart nginx
```

Access the admin UI at `https://YOUR_DOMAIN` after completing Google OAuth setup.

---

## Quick Start (Bare Metal — Ubuntu 22.04)

```bash
sudo bash scripts/bootstrap.sh
```

Follow the post-install steps printed at the end of the script.

---

## Project Layout

```
classguard/
├── backend/          Node.js API + WebSocket server
├── dns-engine/       DNS filtering engine (dns2)
├── frontend/         React 18 admin and teacher UI (Vite + TailwindCSS)
├── extension/        Chrome Extension (Manifest V3)
├── infrastructure/   Nginx config, Kea config, PM2, MDM profiles
├── scripts/          Bootstrap, migrations, seed scripts
├── imageref/         Design reference documents
├── .github/          GitHub Actions workflows and PR/issue templates
├── CHANGELOG.md      Release history
├── VERSION           Current version string
└── docker-compose.yml
```

---

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|----------|-------------|
| `APP_DOMAIN` | Your server's public domain (e.g. `classguard.district.org`) |
| `DB_PASSWORD` | PostgreSQL password |
| `JWT_SECRET` | Random secret for signing JWTs — use `openssl rand -base64 64` |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console OAuth credentials |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console OAuth credentials |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | Path to Google Admin SDK service account JSON |
| `GOOGLE_WORKSPACE_DOMAIN` | Your district's Google Workspace domain |
| `SUPERADMIN_EMAIL` | First admin account email (must be in your Workspace domain) |
| `KEA_CONTROL_AGENT_URL` | Kea Control Agent URL (default: `http://kea:8000`) |

See `.env.example` for the full list.

---

## Contributing

1. Fork the repository and create a feature branch from `main`.
2. Follow the phased build plan in the specification for implementation order.
3. Write tests for new backend services and routes.
4. Open a pull request — CI will run lint and tests automatically.
5. Update `CHANGELOG.md` under `[Unreleased]` with a description of your change.

---

## Versioning

This project uses [Semantic Versioning](https://semver.org/).
The current version is always in the [`VERSION`](VERSION) file.
Full release history is in [`CHANGELOG.md`](CHANGELOG.md).

---

## License

[AGPLv3](LICENSE) — if you deploy a modified version as a service, you must share your changes.
This protects the open-source nature of the project for the school community.
