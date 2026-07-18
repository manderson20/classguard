# Roadmap

Where active work stands and what's next. The live, itemized backlog lives in the [issue tracker](https://github.com/manderson20/classguard/issues) and the project board; this page is the narrative overview. Work is grouped by area (matching the issue labels).

## 🌐 RADIUS / NAC

The network access control layer — BYOD Wi-Fi (Google-credential auth gated by OU), corporate MAC-auth device onboarding, and manual add/block. Core flows are in production.

- DHCP subnet design (greenfield) and rollout
- Migrate remaining building Wi-Fi networks onto the ClassGuard RADIUS profile
- Classroom pilot planning
- Disconnect/CoA on session termination (today a session delete flips a database flag; no live disconnect is sent)
- EAP-TLS device-certificate auth (corporate onboarding is MAC-auth today)

## 📈 Monitoring

- Zabbix server upgrade and dashboard import validation
- Scheduled backups with a retention policy and UI
- Restore-runbook rehearsal on a fresh node pair

See [[Monitoring & Wallboard]].

## 🛡️ Extension & Safety

- Extension rollout testing against a scoped test OU before wider deployment
- Ongoing tuning of keyword and category filtering

## ⚙️ Platform & HA

- New production node pair; current pair becomes the staging/dev environment
- Backup/restore workflow hardening (config, identity keys, host files, database)
- Routine cleanup of test-only artifacts

## How this maps to issues

Each area above is an issue **label**. Milestones group issues into phases. Open the [project board](https://github.com/manderson20/classguard/projects) to see status at a glance, or filter issues by label:

- `area:radius` · `area:monitoring` · `area:extension` · `area:platform` · `area:docs`

---
_[[Home]] · ClassGuard Help Center_
