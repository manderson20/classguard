# Monitoring & Wallboard

ClassGuard exposes health and activity metrics three ways: a built-in wallboard, a token-gated metrics endpoint, and a Zabbix integration. All are configured from **Integrations ▸ Zabbix** ([[Integrations]]).

## Built-in wallboard

A full-screen operations dashboard at **`/wallboard`**, designed for a wall monitor — no external tooling required.

- **Live tiles** — active RADIUS sessions, auth accepts/rejects, pending devices, NAS online, DNS load, and the TLS/EAP certificate countdown.
- **Per-server hardware** — CPU, memory, and disk for every node, with history graphs.
- **HA state** — VRRP role per node and cluster online count.
- **Rotate mode** — append `?rotate=1` (or use the header button) to cycle Network / DNS / Servers panels every 20 seconds.

**Kiosk access:** the wallboard reads a metrics token, so a TV browser can open it with no login session. Copy the kiosk URL from Integrations ▸ Zabbix ▸ Wallboard.

The primary samples every node's metrics once a minute into a short-retention history table, which feeds the graphs. A node that can't be reached appears as unreachable rather than being dropped.

## Metrics endpoint

`/metrics` returns a JSON snapshot (uptime, RADIUS/DNS counters, device counts, certificate days remaining, replication lag, HA state, and OS resource usage). It is protected by a metrics token set in Integrations; localhost and cluster-internal callers are also trusted.

## Zabbix integration

Two layers, meant to be used together:

1. **Agent template** — a Zabbix agent 2 on each node covers OS, container, and service state. The agent auto-installs when a Zabbix server address is set.
2. **HTTP-agent template** — a downloadable template that creates one Zabbix host per node **plus** one for the virtual IP, with cluster-level triggers (failover, split-brain, certificate expiry) that a single-host template can't express. HTTP-agent hosts need no host interface — the server polls the URL directly.

**Dashboards:**
- **Zabbix 7.0** — global dashboards can only be created through the API. Use the `create-dashboard.py` script in `infrastructure/zabbix/`.
- **Zabbix 8.0+** — global-dashboard import is supported. Download the ready dashboard file from Integrations ▸ Zabbix (**Download Dashboard**) and import it (import the host template first — objects are matched by name).

## Import tip

When creating HTTP-agent items in Zabbix, leave the "Convert to JSON" preprocessing option **off** — it wraps the response body and breaks the JSONPath that extracts each metric.

---
_[[Home]] · ClassGuard Help Center_
