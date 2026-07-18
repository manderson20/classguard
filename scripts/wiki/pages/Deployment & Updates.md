# Deployment & Updates

How ClassGuard nodes are updated and kept in sync. For the in-app view of update status and node health, see [[HA Cluster|HA Cluster]] and [[System Health]].

## Update model

Each node runs a host-level **update watcher** on a timer. When an update is scheduled, the watcher pulls the target version from the repository, rebuilds the containers, runs database migrations, and reconciles generated host config (firewall rules, FreeRADIUS, keepalived, monitoring agent).

- Updates are **scheduled per version**, cluster-wide — every active node is offered the same target version.
- A version bump is required for the update flow to offer an update; deploying without bumping the version does nothing.
- The watcher retries the completion handshake while the API is still booting, so a slow start doesn't wedge the update.

## Versioning

ClassGuard uses `MAJOR.MINOR.PATCH`:

- **MAJOR** — breaking changes or milestone releases
- **MINOR** — new features or significant additions
- **PATCH** — bug fixes and minor improvements

The version lives in `VERSION`, the backend and frontend `package.json`, the UI footer, and `CHANGELOG.md` — all bumped together per release.

## Order of a release

1. Merge the change to `main` (branch protection requires green CI).
2. Bump the version and update `CHANGELOG.md`.
3. Schedule the update for all nodes.
4. Watch the rollout; the virtual IP should stay put (a graceful reload keeps VRRP state).
5. Verify the change live.

## High availability during updates

Nodes update one at a time in practice; the floating VIP stays on whichever node is healthy. If a standby is mid-update, the primary keeps serving. See [[HA Cluster|HA Cluster]] for failover behavior and the difference between a VIP move and a database promotion.

## Rollback

Because each node builds from a pinned version, rolling back is scheduling the previous version. Keep the prior release's images until the new one is confirmed healthy.

## Backups

Configuration and identity material are exported via the encrypted backup workflow before a major change — see [[Backup & Restore|Backup and Restore]]. Restore targets a fresh node; restoring over a populated database is intentionally refused.

---
_[[Home]] · ClassGuard Help Center_
