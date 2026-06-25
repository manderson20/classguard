# Privacy

This document describes the privacy posture of the **ClassGuard
open-source project** — the code itself, as published in this repository.
It is not a privacy policy for any specific school district's deployment;
each district running ClassGuard is responsible for its own.

## The Open-Source Project Does Not Collect Your Data

ClassGuard's source code, as published here, does not phone home, does
not transmit usage data to the maintainers, and does not include any
built-in telemetry. Whatever data ClassGuard processes (DNS queries,
screen time, browsing history, safety-evidence screenshots, chat
messages, device inventory, etc.) stays on the infrastructure the
deploying district controls — it is not sent to the project maintainers
or any third party by ClassGuard's own code.

Any data ClassGuard *does* collect or process is collected because the
deploying district configured it to do so (e.g., enabling DNS logging,
screenshot capture, or a Google Workspace integration) — not because the
software does so independently or by default.

## Administrators Are Responsible for Compliance

If you deploy ClassGuard, **you** — not the project maintainers — are
the data controller for whatever student, staff, and network data your
instance processes. That means you are responsible for:

- Compliance with FERPA, COPPA, your state's student privacy laws, and
  any other applicable regulation
- Compliance with your own district's data governance and retention
  policies
- Obtaining whatever consent, notice, or legal basis your district
  requires before monitoring, filtering, or logging student activity
- Securing the data ClassGuard stores (see [SECURITY.md](SECURITY.md))
- Any contractual obligations to parents, students, or your school board
  regarding monitoring and data handling

The project maintainers have no visibility into, access to, or
responsibility for data processed by any individual district's
deployment.

## Third-Party Integrations

If you configure ClassGuard to integrate with Google Workspace, an MDM
provider (Mosyle, etc.), a network controller, or any other third-party
service, data will flow to/from that service according to your own
configuration and that vendor's own terms and privacy policy — review
those independently. ClassGuard's integration code is open source and
auditable, but the maintainers are not a party to, and have no
responsibility for, your agreements with those vendors.

## Future Telemetry or Hosted Services

*[Placeholder: If a future version of ClassGuard introduces optional
telemetry, update notifications that contact a maintainer-run server, or
a maintainer-hosted version of ClassGuard offered as a service, the
specifics of what data that involves and how to opt out will be
documented here before that feature ships.]*

As of this writing, no such telemetry or hosted service exists.

## Development and Testing

**Do not use real student data, real staff data, or any other real PII
when developing, testing, or filing bug reports against ClassGuard**,
unless you are specifically authorized to do so under your district's
policies and have a legitimate operational reason to use real data
rather than synthetic test data. Use fake/synthetic names, emails, and
records for local development, demos, and issue reproduction.

## Questions

This document is not legal advice and does not replace your district's
own privacy counsel or data protection officer. If you have questions
about whether your specific deployment satisfies your legal obligations,
consult your own legal counsel — the project maintainers cannot advise
you on your district's compliance.
