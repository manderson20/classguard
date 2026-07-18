# Zabbix monitoring for ClassGuard

Two complementary layers:

1. **Host layer (this directory)** — Zabbix agent 2 on each cluster node:
   Docker containers, FreeRADIUS/keepalived/update-watcher services, EAP cert
   expiry, failed-update markers, plus every application metric from the
   `/metrics` endpoint parsed into individual items. Template:
   [`templates/classguard_node_by_agent2.yaml`](templates/classguard_node_by_agent2.yaml).
2. **Service layer (built into the app)** — the token-gated `/metrics` HTTP
   endpoint and the auto-generated HTTP-agent template from
   **Integrations ▸ Zabbix** (`GET /metrics/zabbix-template`). That template
   creates one Zabbix host per cluster node **plus one for the VIP**, with
   cluster-level triggers (split-brain, failover, cert expiry) that span both
   nodes — something a per-host template can't express.

Use both: the agent template on each node host, the generated template for
the VIP host and the cross-node triggers.

## Install

**Automatic (recommended):** set **Zabbix Server Address** in
Integrations ▸ Zabbix. Every cluster node's minutely
[`sync-zabbix-agent.sh`](sync-zabbix-agent.sh) then installs Ubuntu's
`zabbix-agent2`, deploys the UserParameters, grants the groups below, and
points the agent at your server — each node registers under its own node ID.
The setting replicates cluster-wide, so future nodes and fresh installs
(`install.sh` Step 8e) converge with zero manual steps. The managed firewall
opens 10050/tcp **to the configured server only** (reconciled every tick, so
changing the address moves the rule). Clearing the setting stops managing
the agent (it's left installed but untouched) and removes the firewall rule.

**Manual (standalone / official repo):**

```bash
sudo ./install-zabbix-agent2.sh --server <zabbix-server-ip> --hostname <node-name>
```

Installs `zabbix-agent2` from repo.zabbix.com's 6.0 LTS channel (Ubuntu 24.04
ships no zabbix packages; a 6.0 agent works against any 6.0+ server — pass
`--official-repo` for the 7.0 channel only if your server is 7.x), drops
`zabbix_agent2_classguard.conf` into `/etc/zabbix/zabbix_agent2.d/`, and adds
the `zabbix` user to the groups the checks need:

| Group     | Why |
|-----------|-----|
| `docker`  | container discovery/stats + `docker exec` for the metrics blob. Note: docker-group membership is root-equivalent; that's the standard trade-off of Zabbix's own Docker monitoring. |
| `adm`     | journald/syslog readability |
| `freerad` | traverse `/etc/freeradius` to read the EAP cert's expiry |

## Zabbix server setup

1. **Import** `templates/classguard_node_by_agent2.yaml`
   (Data collection ▸ Templates ▸ Import — written for the 6.0 schema, which
   6.0 through 7.x servers all accept).
2. **One host per node**, named exactly what you passed as `--hostname`, with
   an agent interface pointing at that node's **real IP — never the VIP**.
   The VIP always answers from whichever node is MASTER, so a host pointed at
   it can never show you a failover.
3. Link the template, set `{$CLASSGUARD.VIP}` to your keepalived VIP, then
   enable the *"VRRP role disagrees with actual VIP ownership"* trigger (it
   ships disabled so it can't misfire before the macro is set).
4. Optionally download the generated template from **Integrations ▸ Zabbix**
   in the ClassGuard UI and import it too — it adds the VIP host ("is the
   service reachable at all") and the multi-host split-brain trigger.
5. Recommended: also link Zabbix's stock **Linux by Zabbix agent** template
   to each host for baseline OS graphs, and **Docker by Zabbix agent 2** if
   you want per-container CPU graphs (our template covers state / memory /
   OOM / restarts).

## How HA is represented

Each node is monitored separately and reports its **own** role:

- `classguard.metric[vrrp_state]` — `MASTER` / `BACKUP` / `FAULT` from
  keepalived's notify hook. The **active server is the one reporting
  MASTER**; a role change fires the *"VRRP role changed (failover event)"*
  trigger on the node that changed.
- `classguard.vip.held[{$CLASSGUARD.VIP}]` — ground truth from `ip addr`,
  cross-checked against the app's claim by the disagreement trigger.
- `classguard.metric[ha_nodes_online]` vs `ha_nodes_total` — every surviving
  node reports a dead peer (the dead one obviously can't).
- Kea DHCP intentionally only runs on the active node (the standby's DB is a
  read-only replica), so "Kea unreachable" only alerts when the node is
  also VRRP master.

## Known limits

- **Cluster-wide metrics alert per-host.** `radius_*`, `dns_*` and
  `ha_nodes_*` come from replicated tables, so both nodes report identical
  values and their triggers fire on each host that carries the template. If
  the duplicate alert bothers you, disable those triggers on one host — or
  rely on the generated (service-layer) template, which raises them once
  from the VIP host. A per-host template cannot deduplicate this itself;
  only multi-host triggers (like the generated split-brain one) can.
- **The metrics blob rides through `docker exec`.** The `/metrics` localhost
  token exemption applies inside the API container only (docker-proxy
  rewrites the source address of host connections). If you'd rather poll
  over HTTP directly, use an HTTP agent item against
  `https://<node>/metrics` with the `X-Metrics-Token` header from
  Integrations ▸ Zabbix — that's exactly what the generated template does.
- **Agent-down is your dead-node signal.** If a whole node dies, everything
  here goes `nodata` — make sure the stock *Zabbix agent is not available*
  trigger (from the host's agent interface availability) is acted on, plus
  the surviving node's "cluster peer is offline".
- **FreeRADIUS internals aren't scraped.** No `Status-Server`/statistics
  vserver is enabled; coverage is service-state + 1812/udp listening +
  ClassGuard's own auth log rates, which has been enough to catch every
  failure mode seen so far (the app logs a row for every auth decision).
- **`systemd.unit.info` needs agent2's systemd plugin** (built into the
  packaged agent). If those items show *unsupported*, check
  `zabbix_agent2 -t 'systemd.unit.info["freeradius.service",ActiveState]'`
  on the node.

## Wall dashboard

Zabbix has no UI import for global dashboards (only template dashboards),
so [`create-dashboard.py`](create-dashboard.py) builds a **ClassGuard
Overview** dashboard through the API from the hosts the generated template
creates — stat tiles (sessions, accepts/rejects, pending devices, DNS),
activity graphs, per-node CPU/memory, TLS-cert and disk gauges, open
problems, and HA state. Sized for a full-screen monitor; Zabbix 7.0+.

```sh
# Token: Zabbix UI → User settings → API tokens (needs dashboard + read perms)
ZABBIX_API_TOKEN=... ./create-dashboard.py --url http://your-zabbix/zabbix
```

Re-running updates the same dashboard in place (safe after adding nodes or
re-importing the template). The script prints a `&kiosk=1` URL for the TV;
pair it with the dashboard's 30-second refresh that it sets by default.
Add `--insecure` for self-signed HTTPS, `--dry-run` to preview the payload.
