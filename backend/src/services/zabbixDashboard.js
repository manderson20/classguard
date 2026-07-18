// Zabbix 8.0 dashboard export generator.
//
// Zabbix 8.0 adds global-dashboard import/export (Dashboards > Import);
// earlier versions can only build dashboards by hand or over the API
// (infrastructure/zabbix/create-dashboard.py covers 7.0). The import file
// references every object BY NAME — items as {host, key}, host groups as
// {name} — so this generator emits a ready dashboard for the hosts the
// Zabbix template export creates ("ClassGuard - <node>" + "ClassGuard -
// VIP") with no IDs to resolve. Served as JSON (also an accepted import
// format) to keep serialization trivial and exact.
//
// Schema source: Zabbix 8.0 C80ImportValidator (dashboards rules) and
// CConfigurationExportBuilder::formatDashboards — widget types are the
// plain widget strings ('item', 'svggraph', 'gauge', 'problems'); field
// types are the named constants (INTEGER, STRING, ITEM, GROUP); geometry
// uses the 72-column grid.
//
// Colors follow the validated dark-surface data-viz palette used by the
// built-in wallboard (Zabbix hex has no leading '#'): node identity =
// categorical slots in fixed order; accepts/rejects = blue/red poles.

const HOST_GROUP = 'ClassGuard';
const NODE_COLORS = ['3987E5', '008300', 'D55181', 'C98500'];
const ACCEPTS = '3987E5', REJECTS = 'E66767', QUERIES = '3987E5', BLOCKED = 'D95926';
const RED = 'D03B3B', ORANGE = 'F39C12', GREEN = '429E47';

const fInt   = (name, value) => ({ type: 'INTEGER', name, value: String(value) });
const fStr   = (name, value) => ({ type: 'STRING', name, value: String(value) });
const fItem  = (name, host, key) => ({ type: 'ITEM', name, value: { host, key: `classguard.${key}` } });
const fGroup = (name, groupName) => ({ type: 'GROUP', name, value: { name: groupName } });

function statTile(x, y, w, h, host, key, label, thresholds = []) {
  const fields = [
    fItem('itemid.0', host, key),
    fInt('show.0', 1), // description
    fInt('show.1', 2), // value
    fStr('description', label),
    fInt('desc_v_pos', 0),
  ];
  thresholds.forEach(([threshold, color], i) => {
    fields.push(fStr(`thresholds.${i}.threshold`, threshold));
    fields.push(fStr(`thresholds.${i}.color`, color));
  });
  return { type: 'item', name: label, x: String(x), y: String(y),
    width: String(w), height: String(h), fields };
}

// datasets: [{ hosts: [..], item: 'ClassGuard: <item name>', color }] —
// pattern data sets, one line per matched item, so N nodes need no schema
// change. Item patterns match by ITEM NAME (not key) in svggraph.
function svgGraph(x, y, w, h, name, datasets) {
  const fields = [];
  datasets.forEach((ds, i) => {
    ds.hosts.forEach((host, j) => fields.push(fStr(`ds.${i}.hosts.${j}`, host)));
    fields.push(fStr(`ds.${i}.items.0`, ds.item));
    fields.push(fStr(`ds.${i}.color`, ds.color));
    fields.push(fInt(`ds.${i}.fill`, 2));
    fields.push(fInt(`ds.${i}.transparency`, 3));
  });
  return { type: 'svggraph', name, x: String(x), y: String(y),
    width: String(w), height: String(h), fields };
}

function gauge(x, y, w, h, host, key, label, min, max, thresholds, units = '') {
  const fields = [
    fItem('itemid.0', host, key),
    fStr('description', label),
    fStr('min', min),
    fStr('max', max),
    fInt('th_show_arc', 1),
    fInt('decimal_places', 0),
  ];
  if (units) {
    fields.push(fInt('units_show', 1));
    fields.push(fStr('units', units));
  }
  thresholds.forEach(([threshold, color], i) => {
    fields.push(fStr(`thresholds.${i}.threshold`, threshold));
    fields.push(fStr(`thresholds.${i}.color`, color));
  });
  return { type: 'gauge', name: label, x: String(x), y: String(y),
    width: String(w), height: String(h), fields };
}

// vipHost: "ClassGuard - VIP"-style tech name; nodeHosts: per-node tech
// names with short display names, e.g. [{ techName, shortName }].
function buildDashboardExport(vipHost, nodeHosts) {
  const nodeTech = nodeHosts.map(n => n.techName);
  const itemName = key => `ClassGuard: ${key.replace(/_/g, ' ')}`;

  const overview = { name: 'Overview', display_period: '0', widgets: [
    statTile(0,  0, 12, 4, vipHost, 'radius_sessions_active', 'Active Sessions'),
    statTile(12, 0, 12, 4, vipHost, 'radius_auth_accepts_5m', 'Accepts (5m)'),
    statTile(24, 0, 12, 4, vipHost, 'radius_auth_rejects_5m', 'Rejects (5m)', [['20', RED]]),
    statTile(36, 0, 12, 4, vipHost, 'radius_devices_pending', 'Pending Devices', [['1', ORANGE]]),
    statTile(48, 0, 12, 4, vipHost, 'dns_queries_per_second', 'DNS Queries/s'),
    statTile(60, 0, 12, 4, vipHost, 'dns_blocked_24h', 'DNS Blocked (24h)'),
    { type: 'problems', name: 'Open problems', x: '0', y: '4', width: '36', height: '8',
      fields: [fGroup('groupids.0', HOST_GROUP), fInt('show_opdata', 2)] },
    gauge(36, 4, 12, 8, vipHost, 'tls_cert_days_remaining', 'TLS/EAP cert', '0', '90',
      [['0', RED], ['14', ORANGE], ['30', GREEN]], 'days'),
    gauge(48, 4, 12, 8, vipHost, 'os_disk_used_pct', 'Disk used (active node)', '0', '100',
      [['80', ORANGE], ['90', RED]], '%'),
    statTile(60, 4, 12, 4, vipHost, 'ha_nodes_online', 'Nodes Online'),
    statTile(60, 8, 12, 4, vipHost, 'radius_nas_active', 'NAS Online'),
  ] };

  const network = { name: 'Network & DNS', display_period: '0', widgets: [
    svgGraph(0, 0, 36, 9, 'RADIUS authentications (5-min window)', [
      { hosts: [vipHost], item: itemName('radius_auth_accepts_5m'), color: ACCEPTS },
      { hosts: [vipHost], item: itemName('radius_auth_rejects_5m'), color: REJECTS },
    ]),
    svgGraph(36, 0, 36, 9, 'Active RADIUS sessions', [
      { hosts: [vipHost], item: itemName('radius_sessions_active'), color: ACCEPTS },
    ]),
    svgGraph(0, 9, 36, 9, 'DNS queries vs blocked (60s)', [
      { hosts: [vipHost], item: itemName('dns_queries_last_60s'), color: QUERIES },
      { hosts: [vipHost], item: itemName('dns_blocked_last_60s'), color: BLOCKED },
    ]),
    svgGraph(36, 9, 36, 9, 'DNS block rate %', [
      { hosts: [vipHost], item: itemName('dns_block_rate_pct'), color: BLOCKED },
    ]),
  ] };

  const servers = { name: 'Servers', display_period: '0', widgets: [
    svgGraph(0, 0, 36, 9, 'CPU load % by node', [
      { hosts: nodeTech, item: itemName('os_cpu_load_pct'), color: NODE_COLORS[0] },
    ]),
    svgGraph(36, 0, 36, 9, 'Memory used % by node', [
      { hosts: nodeTech, item: itemName('os_mem_used_pct'), color: NODE_COLORS[1] },
    ]),
  ] };
  nodeHosts.slice(0, 3).forEach((n, i) => {
    servers.widgets.push(statTile(i * 24, 9, 12, 4, n.techName, 'vrrp_state', `VRRP ${n.shortName}`));
    servers.widgets.push(statTile(i * 24 + 12, 9, 12, 4, n.techName, 'failover_priority', `Priority ${n.shortName}`));
    servers.widgets.push(gauge(i * 24, 13, 24, 6, n.techName, 'os_disk_used_pct',
      `Disk used — ${n.shortName}`, '0', '100', [['80', ORANGE], ['90', RED]], '%'));
  });

  return {
    zabbix_export: {
      version: '8.0',
      dashboards: [{
        name: 'ClassGuard Overview',
        display_period: '30',
        auto_start: 'YES',
        pages: [overview, network, servers],
      }],
    },
  };
}

module.exports = { buildDashboardExport };
