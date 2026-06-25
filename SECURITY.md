# Security Policy

ClassGuard handles sensitive functions for a school network — content
filtering, authentication, DHCP/DNS, RADIUS/NAC, and device management.
We take security reports seriously, but please read the expectations
below before reporting.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security vulnerability.**
Public issues are visible to everyone, including anyone who might want
to exploit the problem before a fix exists.

Instead, report it privately:

- Open a [GitHub Security Advisory](../../security/advisories/new) on this
  repository (preferred — keeps the report private until resolved), or
- Email the maintainer directly (see the repository's GitHub profile for
  contact info) with a clear subject line indicating it's a security report.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce it, or a proof-of-concept if you have one
- The version/commit you tested against
- Whether you're aware of it being exploited in the wild

## Coordinated Disclosure

Please give maintainers a reasonable amount of time to investigate and
release a fix before disclosing a vulnerability publicly. We'll do our
best to acknowledge your report, keep you updated on progress, and credit
you (if you'd like) once a fix is released. This is a community open-source
project without a dedicated security team, so response times are
best-effort, not guaranteed under any SLA.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release on `main` | ✅ |
| Older tagged releases | ❌ (not backported) |

This project does not currently maintain long-term-support branches.
Security fixes are made against the latest version only — please keep
your deployment up to date.

## Scope and Limitations

Security fixes for this project are **best-effort**, provided by volunteer
maintainers and contributors with no guaranteed response time, and with no
warranty of completeness or correctness. This is explicitly not a
commercially-supported product unless you have a separate agreement
stating otherwise.

**You are responsible for securing your own deployment.** ClassGuard
touches authentication, network services, and student data — running it
safely requires the same diligence you'd apply to any other
self-hosted, security-sensitive infrastructure, including (but not
limited to):

- Keeping the server OS, Docker, and ClassGuard itself patched and current
- Using strong, unique secrets (`.env` values, `install.sh` already
  generates random secrets — don't reuse or weaken them)
- Restricting network exposure of admin interfaces and internal services
  to only what needs to be reachable
- Reviewing who has admin/superadmin access and what permissions they hold
- Maintaining your own backups (see `BackupPage` / `DEPLOYMENT.md`)
  independent of relying on this project's code being defect-free
- Complying with your district's own security, data-retention, and
  privacy policies — this project does not do that compliance work for you

See also [DISCLAIMER.md](DISCLAIMER.md) and [PRIVACY.md](PRIVACY.md).
