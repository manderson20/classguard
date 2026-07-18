#!/usr/bin/env python3
"""Create (or update) the "ClassGuard Overview" dashboard on a Zabbix server.

Zabbix has no UI import for global dashboards -- they can only be created
through the JSON-RPC API -- so this script builds one from the hosts the
generated HTTP-agent template creates (Integrations > Zabbix): one host per
cluster node named "ClassGuard - <node>" plus "ClassGuard - VIP". Run it
once after importing that template; re-running updates the same dashboard
in place, so it is safe to iterate on and re-apply after adding nodes.

Layout (72-column grid, sized for a full-screen wall monitor):
  row 1  -- live stat tiles: sessions, accepts/rejects, pending devices, DNS
  row 2  -- graphs: RADIUS auth results, DNS queries vs blocked, sessions
  row 3  -- per-node CPU + memory graphs, TLS-cert and disk gauges
  row 4  -- open problems + HA tiles (VRRP state, nodes online, devices)

Requires Zabbix 7.0+ (gauge widgets, 72-column grid) and an API token
(Zabbix UI: User settings > API tokens, or Users > API tokens as admin).
The token is read from --token-file, the ZABBIX_API_TOKEN environment
variable, or an interactive prompt -- never from argv, so it stays out of
shell history and the process list.

Usage:
  ZABBIX_API_TOKEN=... ./create-dashboard.py --url http://zabbix.example.local/zabbix
  ./create-dashboard.py --url https://... --token-file /path/to/token --insecure

For a TV, open the printed kiosk URL (append &kiosk=1 to any dashboard URL).
"""

import argparse
import getpass
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

DASHBOARD_NAME_DEFAULT = 'ClassGuard Overview'
HOST_PREFIX = 'ClassGuard - '
VIP_HOST = 'ClassGuard - VIP'
HOST_GROUP = 'ClassGuard'

# Palette: colorblind-safe, matches severity conventions (green ok / red bad).
GREEN, RED, BLUE, ORANGE, PURPLE, YELLOW = (
    '429E47', 'E45959', '4A90D9', 'F39C12', '7D5CA6', 'F1C40F')


class ZabbixApi:
    def __init__(self, url, token, insecure=False):
        self.endpoint = url.rstrip('/') + '/api_jsonrpc.php'
        self.token = token
        self.ctx = ssl._create_unverified_context() if insecure else None
        self._id = 0

    def call(self, method, params):
        self._id += 1
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps({'jsonrpc': '2.0', 'method': method,
                             'params': params, 'id': self._id}).encode(),
            headers={'Content-Type': 'application/json-rpc'})
        # 7.0 rejects apiinfo.version when an auth header is present.
        if method != 'apiinfo.version':
            req.add_header('Authorization', f'Bearer {self.token}')
        with urllib.request.urlopen(req, timeout=30, context=self.ctx) as r:
            body = json.loads(r.read())
        if 'error' in body:
            e = body['error']
            raise SystemExit(f"Zabbix API error from {method}: "
                             f"{e.get('message')} {e.get('data', '')}".strip())
        return body['result']


# --- widget builders --------------------------------------------------------

def f_int(name, value):  return {'type': 0, 'name': name, 'value': str(value)}
def f_str(name, value):  return {'type': 1, 'name': name, 'value': str(value)}
def f_group(name, value): return {'type': 2, 'name': name, 'value': str(value)}
def f_item(name, value): return {'type': 4, 'name': name, 'value': str(value)}


def stat_tile(x, y, w, h, itemid, label, thresholds=None):
    fields = [
        f_item('itemid.0', itemid),
        f_int('show.0', 1),          # description
        f_int('show.1', 2),          # value
        f_str('description', label),
        f_int('desc_v_pos', 0),      # label on top, value centered below
        f_int('desc_size', 15),
    ]
    for i, (threshold, color) in enumerate(thresholds or []):
        fields.append(f_str(f'thresholds.{i}.threshold', threshold))
        fields.append(f_str(f'thresholds.{i}.color', color))
    return {'type': 'item', 'name': label,
            'x': x, 'y': y, 'width': w, 'height': h, 'fields': fields}


def svg_graph(x, y, w, h, name, datasets):
    """datasets: list of (host_names, item_name, color). Each data set draws
    one line per matched item, so passing several hosts in one set graphs
    every node without hardcoding the node count."""
    fields = []
    for i, (hosts, item, color) in enumerate(datasets):
        for j, host in enumerate(hosts):
            fields.append(f_str(f'ds.{i}.hosts.{j}', host))
        fields.append(f_str(f'ds.{i}.items.0', item))
        fields.append(f_str(f'ds.{i}.color', color))
        fields.append(f_int(f'ds.{i}.fill', 2))
        fields.append(f_int(f'ds.{i}.transparency', 3))
    return {'type': 'svggraph', 'name': name,
            'x': x, 'y': y, 'width': w, 'height': h, 'fields': fields}


def gauge(x, y, w, h, itemid, label, gmin, gmax, thresholds, units=''):
    fields = [
        f_item('itemid.0', itemid),
        f_str('description', label),
        f_int('desc_size', 12),
        f_str('min', gmin),
        f_str('max', gmax),
        f_int('th_show_arc', 1),
        f_int('decimal_places', 0),
    ]
    if units:
        fields.append(f_int('units_show', 1))
        fields.append(f_str('units', units))
    for i, (threshold, color) in enumerate(thresholds):
        fields.append(f_str(f'thresholds.{i}.threshold', threshold))
        fields.append(f_str(f'thresholds.{i}.color', color))
    return {'type': 'gauge', 'name': label,
            'x': x, 'y': y, 'width': w, 'height': h, 'fields': fields}


def problems(x, y, w, h, groupid):
    return {'type': 'problems', 'name': 'Open problems',
            'x': x, 'y': y, 'width': w, 'height': h,
            'fields': [f_group('groupids.0', groupid),
                       f_int('show_opdata', 2)]}


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--url', required=True,
                    help='Zabbix frontend base URL, e.g. http://host/zabbix')
    ap.add_argument('--name', default=DASHBOARD_NAME_DEFAULT)
    ap.add_argument('--token-file', help='file containing the API token')
    ap.add_argument('--insecure', action='store_true',
                    help='skip TLS certificate verification')
    ap.add_argument('--dry-run', action='store_true',
                    help='resolve everything and print the payload, no write')
    args = ap.parse_args()

    if args.token_file:
        token = open(args.token_file).read().strip()
    else:
        token = os.environ.get('ZABBIX_API_TOKEN') or getpass.getpass(
            'Zabbix API token: ')

    api = ZabbixApi(args.url, token, insecure=args.insecure)

    version = api.call('apiinfo.version', {})
    if tuple(int(p) for p in version.split('.')[:2]) < (7, 0):
        raise SystemExit(f'Zabbix {version} found -- this dashboard needs 7.0+ '
                         '(gauge widgets, 72-column grid).')

    hosts = api.call('host.get', {
        'output': ['hostid', 'host'],
        'search': {'host': HOST_PREFIX},
        'startSearch': True,
    })
    by_name = {h['host']: h['hostid'] for h in hosts}
    if VIP_HOST not in by_name:
        raise SystemExit(
            f'Host "{VIP_HOST}" not found on this Zabbix server. Import the '
            'template from Integrations > Zabbix first.')
    node_hosts = sorted(n for n in by_name if n != VIP_HOST)

    items = api.call('item.get', {
        'hostids': [h['hostid'] for h in hosts],
        'search': {'key_': 'classguard.'},
        'output': ['itemid', 'key_', 'hostid'],
    })
    itemid_by_host_key = {(i['hostid'], i['key_']): i['itemid'] for i in items}

    def itemid(host_name, key):
        iid = itemid_by_host_key.get((by_name[host_name], f'classguard.{key}'))
        if not iid:
            raise SystemExit(f'Item classguard.{key} missing on "{host_name}" '
                             '-- re-import the template and retry.')
        return iid

    groups = api.call('hostgroup.get', {'filter': {'name': [HOST_GROUP]}})
    if not groups:
        raise SystemExit(f'Host group "{HOST_GROUP}" not found.')
    groupid = groups[0]['groupid']

    vip = VIP_HOST
    widgets = [
        # Row 1: live stats.
        stat_tile(0,  0, 12, 4, itemid(vip, 'radius_sessions_active'), 'Active Sessions'),
        stat_tile(12, 0, 12, 4, itemid(vip, 'radius_auth_accepts_5m'), 'Accepts (5m)'),
        stat_tile(24, 0, 12, 4, itemid(vip, 'radius_auth_rejects_5m'), 'Rejects (5m)',
                  thresholds=[('20', RED)]),
        stat_tile(36, 0, 12, 4, itemid(vip, 'radius_devices_pending'), 'Pending Devices',
                  thresholds=[('1', ORANGE)]),
        stat_tile(48, 0, 12, 4, itemid(vip, 'dns_queries_per_second'), 'DNS Queries/s'),
        stat_tile(60, 0, 12, 4, itemid(vip, 'dns_blocked_24h'), 'DNS Blocked (24h)'),

        # Row 2: activity graphs.
        svg_graph(0, 4, 24, 8, 'RADIUS authentications (5-min window)', [
            ([vip], 'ClassGuard: radius auth accepts 5m', GREEN),
            ([vip], 'ClassGuard: radius auth rejects 5m', RED)]),
        svg_graph(24, 4, 24, 8, 'DNS queries vs blocked (60s)', [
            ([vip], 'ClassGuard: dns queries last 60s', BLUE),
            ([vip], 'ClassGuard: dns blocked last 60s', ORANGE)]),
        svg_graph(48, 4, 24, 8, 'Active RADIUS sessions', [
            ([vip], 'ClassGuard: radius sessions active', PURPLE)]),

        # Row 3: node health.
        svg_graph(0, 12, 24, 8, 'CPU load % by node', [
            (node_hosts, 'ClassGuard: os cpu load pct', YELLOW)]),
        svg_graph(24, 12, 24, 8, 'Memory used % by node', [
            (node_hosts, 'ClassGuard: os mem used pct', BLUE)]),
        gauge(48, 12, 12, 8, itemid(vip, 'tls_cert_days_remaining'),
              'TLS/EAP cert', '0', '90',
              [('0', RED), ('14', ORANGE), ('30', GREEN)], units='days'),
        gauge(60, 12, 12, 8, itemid(vip, 'os_disk_used_pct'),
              'Disk used (active node)', '0', '100',
              [('80', ORANGE), ('90', RED)], units='%'),

        # Row 4: problems + HA state.
        problems(0, 20, 36, 6, groupid),
    ]
    # HA tiles: VRRP state per node, then cluster-wide counters.
    ha_tiles = [(itemid(n, 'vrrp_state'), f'VRRP {n[len(HOST_PREFIX):]}')
                for n in node_hosts]
    ha_tiles += [
        (itemid(vip, 'ha_nodes_online'), 'Nodes Online'),
        (itemid(vip, 'radius_nas_active'), 'NAS Online'),
        (itemid(vip, 'radius_devices_approved'), 'Approved Devices'),
        (itemid(vip, 'radius_devices_blocked'), 'Blocked Devices'),
    ]
    for i, (iid, label) in enumerate(ha_tiles[:6]):
        widgets.append(stat_tile(36 + (i % 3) * 12, 20 + (i // 3) * 3, 12, 3,
                                 iid, label))

    payload = {
        'name': args.name,
        'display_period': 30,
        'auto_start': 1,
        'private': 0,
        'pages': [{'widgets': widgets}],
    }

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return

    existing = api.call('dashboard.get',
                        {'filter': {'name': [args.name]}, 'output': ['dashboardid']})
    if existing:
        dashboardid = existing[0]['dashboardid']
        api.call('dashboard.update', {'dashboardid': dashboardid, **payload})
        action = 'Updated'
    else:
        dashboardid = api.call('dashboard.create', payload)['dashboardids'][0]
        action = 'Created'

    base = args.url.rstrip('/')
    print(f'{action} dashboard "{args.name}" (id {dashboardid})')
    print(f'  View:  {base}/zabbix.php?action=dashboard.view&dashboardid={dashboardid}')
    print(f'  Kiosk: {base}/zabbix.php?action=dashboard.view&dashboardid={dashboardid}&kiosk=1')


if __name__ == '__main__':
    main()
