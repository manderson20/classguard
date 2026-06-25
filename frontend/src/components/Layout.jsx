import { useEffect, useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import MdiIcon from '@mdi/react';
import {
  mdiViewDashboardOutline,
  mdiChartLine,
  mdiAccountMultipleOutline,
  mdiFileDocumentOutline,
  mdiAccountGroupOutline,
  mdiFormatListBulletedSquare,
  mdiChartBar,
  mdiShieldOutline,
  mdiTagOutline,
  mdiCameraOutline,
  mdiLockOutline,
  mdiLock,
  mdiRobotOutline,
  mdiIpNetworkOutline,
  mdiDnsOutline,
  mdiServerOutline,
  mdiSitemap,
  mdiSwapHorizontal,
  mdiClockOutline,
  mdiPuzzleOutline,
  mdiAccountSyncOutline,
  mdiCogOutline,
  mdiHomeOutline,
  mdiFlagOutline,
  mdiLogoutVariant,
  mdiFilterOutline,
  mdiEmailOutline,
  mdiPhoneOutline,
  mdiChatOutline,
  mdiHistory,
  mdiPulse,
  mdiEyeOutline,
  mdiVpn,
  mdiTunnelOutline,
  mdiAccountKeyOutline,
  mdiBellAlertOutline,
  mdiIncognito,
  mdiBackupRestore,
  mdiShieldAlertOutline,
  mdiClipboardTextMultipleOutline,
  mdiLaptopOff,
  mdiWifiAlert,
  mdiHelpCircleOutline,
} from '@mdi/js';
import logo from '../assets/logo.png';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

const VERSION = '0.7.38';
const ROLES   = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

function Icon({ path }) {
  return <MdiIcon path={path} size="1em" className="flex-shrink-0" />;
}

// Self-harm/violence-tier safety events (risk_score >= 85) page every
// logged-in staff member in real time via the 'role:staff' socket room
// (backend/src/sockets/index.js), not just whoever has the right class
// room open — too urgent to rely on someone happening to check the queue.
function UrgentAlertBanner({ socket, navigate }) {
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    if (!socket) return;
    const onAlert = (payload) => setAlerts(a => [...a, payload]);
    socket.on('safety:urgent_alert', onAlert);
    return () => socket.off('safety:urgent_alert', onAlert);
  }, [socket]);

  if (!alerts.length) return null;

  return (
    <div className="bg-red-600 text-white px-4 py-2 flex items-center gap-3 flex-wrap">
      <span className="font-semibold text-sm">⚠ Urgent safety alert{alerts.length > 1 ? `s (${alerts.length})` : ''}:</span>
      <span className="text-sm">
        {alerts[alerts.length - 1].category} content flagged (risk {alerts[alerts.length - 1].riskScore}) — review immediately.
      </span>
      <button
        className="ml-auto bg-white text-red-700 text-xs font-semibold px-3 py-1 rounded hover:bg-red-50"
        onClick={() => { setAlerts([]); navigate('/admin/screenshots'); }}
      >
        Review now
      </button>
      <button
        className="text-white/80 hover:text-white text-xs"
        onClick={() => setAlerts([])}
      >
        Dismiss
      </button>
    </div>
  );
}

// Shown whenever the current session is an impersonation token (see
// routes/impersonation.js) -- the one place in the UI that makes "you are
// not actually this teacher" unmissable, since the session otherwise looks
// and behaves exactly like a real teacher login by design (same userId,
// same role, same data). Purple rather than the red/amber alert banners
// above since this isn't an alert, just a persistent status the admin
// needs to keep seeing for as long as the session lasts.
function ImpersonationBanner({ user, navigate }) {
  const { endImpersonation } = useAuth();
  const [ending, setEnding] = useState(false);
  if (!user?.impersonatedBy) return null;

  const handleExit = async () => {
    setEnding(true);
    await endImpersonation();
    navigate('/admin');
  };

  return (
    <div className="bg-purple-700 text-white px-4 py-2 flex items-center gap-3 flex-wrap">
      <MdiIcon path={mdiIncognito} size="1.1em" className="flex-shrink-0" />
      <span className="font-semibold text-sm">
        Viewing as {user.full_name || user.email} (Teacher)
      </span>
      <span className="text-sm text-purple-200">
        — you are {user.impersonatedBy.name || user.impersonatedBy.email}, impersonating this account. Every change you make is logged.
      </span>
      <button
        className="ml-auto bg-white text-purple-700 text-xs font-semibold px-3 py-1 rounded hover:bg-purple-50 disabled:opacity-60"
        onClick={handleExit}
        disabled={ending}
      >
        {ending ? 'Exiting…' : 'Exit impersonation'}
      </button>
    </div>
  );
}

// Confirmed filter bypass (services/filterBypassDetection.js) -- a
// student-safety event like the urgent banner above, not infra, since the
// whole point is the content filter has stopped applying to this device.
function FilterBypassBanner({ socket, navigate }) {
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    if (!socket) return;
    const onAlert = (payload) => setAlerts(a => [...a, payload]);
    socket.on('safety:filter_bypass', onAlert);
    return () => socket.off('safety:filter_bypass', onAlert);
  }, [socket]);

  if (!alerts.length) return null;
  const latest = alerts[alerts.length - 1];

  return (
    <div className="bg-red-600 text-white px-4 py-2 flex items-center gap-3 flex-wrap">
      <span className="font-semibold text-sm">⚠ Possible filter bypass{alerts.length > 1 ? `s (${alerts.length})` : ''}:</span>
      <span className="text-sm">
        {latest.studentName}'s device ({latest.ipAddress}) has generated no web traffic through the filter for several minutes.
      </span>
      <button
        className="ml-auto bg-white text-red-700 text-xs font-semibold px-3 py-1 rounded hover:bg-red-50"
        onClick={() => { setAlerts([]); navigate('/admin/filter-bypass'); }}
      >
        Review now
      </button>
      <button
        className="text-white/80 hover:text-white text-xs"
        onClick={() => setAlerts([])}
      >
        Dismiss
      </button>
    </div>
  );
}

// Upstream internet/DNS outage or recovery — same staff-wide socket room as
// the safety banner above, but amber rather than red since this is an
// infra concern, not a student-safety emergency, and it's just as relevant
// to "is the down alert itself going to reach anyone" if email can't.
function InternetHealthBanner({ socket, navigate }) {
  const [alert, setAlert] = useState(null);

  useEffect(() => {
    if (!socket) return;
    const onAlert = (payload) => setAlert(payload);
    socket.on('system:internet_alert', onAlert);
    return () => socket.off('system:internet_alert', onAlert);
  }, [socket]);

  if (!alert) return null;

  return (
    <div className="bg-amber-500 text-white px-4 py-2 flex items-center gap-3 flex-wrap">
      <span className="font-semibold text-sm">
        {alert.kind === 'down' ? '⚠ Internet issue:' : '✓ Internet recovered:'}
      </span>
      <span className="text-sm">
        {alert.kind === 'down'
          ? `${alert.what} appears to be down.${alert.error ? ` (${alert.error})` : ''}`
          : `${alert.what} is back up.`}
      </span>
      <button
        className="ml-auto bg-white text-amber-700 text-xs font-semibold px-3 py-1 rounded hover:bg-amber-50"
        onClick={() => { setAlert(null); navigate('/admin'); }}
      >
        View dashboard
      </button>
      <button
        className="text-white/80 hover:text-white text-xs"
        onClick={() => setAlert(null)}
      >
        Dismiss
      </button>
    </div>
  );
}

// Floating, page-aware help button -- resolves the current route to its
// linked Knowledge Base article(s) (see routes/knowledgeBase.js's
// /for-page lookup) so every page has a help link without needing one
// wired into each individual page component. Falls back to the general
// Help Center list if nothing's linked yet for this page, or if there's
// more than one match.
function ContextualHelpButton({ navigate }) {
  const location = useLocation();
  const { data: matches = [] } = useQuery({
    queryKey: ['kb-for-page', location.pathname],
    queryFn: () => api.get(`/kb/for-page?path=${encodeURIComponent(location.pathname)}`),
    staleTime: 60_000,
  });

  const go = () => {
    if (matches.length === 1) navigate(`/help/${matches[0].slug}`);
    else navigate('/help');
  };

  return (
    <button
      onClick={go}
      title={matches.length === 1 ? `Help: ${matches[0].title}` : 'Help Center'}
      className="fixed bottom-5 right-5 z-40 w-11 h-11 rounded-full bg-slate-800 text-white shadow-lg flex items-center justify-center hover:bg-slate-700"
    >
      <MdiIcon path={mdiHelpCircleOutline} size="1.3em" />
    </button>
  );
}

// HA auto-promotion firing — superadmin-only room (backend/src/sockets/
// index.js), since "a node just auto-promoted its database" is meaningless
// noise to a teacher or building admin. Red, not amber, since unlike the
// internet-health banner above this is irreversible and may mean the
// cluster has just split-brained.
function HaAutoPromoteBanner({ socket, navigate }) {
  const [alert, setAlert] = useState(null);

  useEffect(() => {
    if (!socket) return;
    const onAlert = (payload) => setAlert(payload);
    socket.on('system:ha_auto_promote', onAlert);
    return () => socket.off('system:ha_auto_promote', onAlert);
  }, [socket]);

  if (!alert) return null;

  return (
    <div className="bg-red-600 text-white px-4 py-2 flex items-center gap-3 flex-wrap">
      <span className="font-semibold text-sm">
        {alert.ok ? '⚠ HA auto-promotion fired:' : '⚠ HA auto-promotion FAILED:'}
      </span>
      <span className="text-sm">
        {alert.ok
          ? `Node ${alert.node_id} auto-promoted itself to primary. Check for split-brain before trusting both copies agree.`
          : `Node ${alert.node_id} tried to auto-promote and failed (${alert.error}). Still read-only — needs manual attention.`}
      </span>
      <button
        className="ml-auto bg-white text-red-700 text-xs font-semibold px-3 py-1 rounded hover:bg-red-50"
        onClick={() => { setAlert(null); navigate('/admin/ha'); }}
      >
        View HA page
      </button>
      <button
        className="text-white/80 hover:text-white text-xs"
        onClick={() => setAlert(null)}
      >
        Dismiss
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav definitions
// ---------------------------------------------------------------------------

// Sidebar nav-view switcher options — a dropdown instead of a fixed
// admin/teacher toggle specifically so adding a future view (e.g. a
// counselor- or IT-focused nav) is just one more entry here, not a UI
// rewrite. Adding an entry alone doesn't render anything new on its own —
// it still needs its own nav section + the showTeacherNav-style condition
// below — but the switcher control itself scales to any number of views.
const NAV_VIEWS = [
  { value: 'admin',   label: 'Admin' },
  { value: 'teacher', label: 'Teacher' },
];

const TEACHER_NAV = [
  { to: '/classes',     icon: mdiHomeOutline, label: 'My Classes'  },
  { to: '/penalty-box', icon: mdiFlagOutline,  label: 'Penalty Box' },
  { to: '/lockdown',    icon: mdiLock,         label: 'Lockdown Tests' },
  { to: '/help',        icon: mdiHelpCircleOutline, label: 'Help Center' },
];

const ADMIN_SECTIONS = [
  {
    label: 'Overview',
    items: [
      { to: '/admin',                 icon: mdiViewDashboardOutline,   label: 'Dashboard',      end: true },
      { to: '/admin/staff-analytics', icon: mdiChartLine,              label: 'Staff Analytics', permissionKey: 'staff_analytics' },
      { to: '/admin/screen-time',     icon: mdiClockOutline,           label: 'Screen Time'     },
      { to: '/admin/users',           icon: mdiAccountMultipleOutline, label: 'Users',           permissionKey: 'users' },
      { to: '/help',                  icon: mdiHelpCircleOutline,      label: 'Help Center'     },
    ],
  },
  {
    label: 'Policies & Safety',
    items: [
      { to: '/admin/policies',          icon: mdiFileDocumentOutline, label: 'Policies',         permissionKey: 'policies' },
      { to: '/admin/policy-simulator', icon: mdiFilterOutline,        label: 'Filter Simulator', permissionKey: 'policies' },
      { to: '/admin/groups',           icon: mdiAccountGroupOutline,  label: 'Groups',           permissionKey: 'groups' },
      { to: '/admin/blocklists',  icon: mdiShieldOutline,       label: 'Blocklists',    permissionKey: 'blocklists' },
      { to: '/admin/categories',  icon: mdiTagOutline,          label: 'Categories',    permissionKey: 'categories' },
      { to: '/admin/screenshots',       icon: mdiCameraOutline,  label: 'Screenshots',       permissionKey: 'screenshots' },
      { to: '/admin/browser-history',   icon: mdiHistory,        label: 'Browser History',   permissionKey: 'browser_history' },
      { to: '/admin/chat',              icon: mdiChatOutline,    label: 'Chat Audit',        permissionKey: 'chat_audit' },
      { to: '/admin/device-view-audit', icon: mdiEyeOutline,     label: 'Device View Audit', permissionKey: 'device_view_audit' },
      { to: '/admin/impersonation-audit', icon: mdiIncognito,   label: 'Impersonation Audit', permissionKey: 'impersonate_users' },
      { to: '/admin/ai',                icon: mdiRobotOutline,   label: 'AI Classifier',     permissionKey: 'ai_classifier' },
      { to: '/admin/safety-alerts',     icon: mdiBellAlertOutline, label: 'Safety Alerts',   permissionKey: 'safety_alerts' },
      { to: '/admin/filter-bypass',     icon: mdiWifiAlert,     label: 'Filter Bypass Alerts', permissionKey: 'safety_alerts' },
      { to: '/admin/unblock-requests',  icon: mdiEmailOutline,   label: 'Unblock Requests', badge: true, permissionKey: 'unblock_requests' },
    ],
  },
  {
    label: 'DNS & Network',
    items: [
      { to: '/admin/dns/logs',     icon: mdiFormatListBulletedSquare, label: 'DNS Logs',     permissionKey: 'dns_logs' },
      { to: '/admin/dns/stats',    icon: mdiChartBar,                 label: 'DNS Stats',    permissionKey: 'dns_logs' },
      { to: '/admin/dns/records',  icon: mdiDnsOutline,               label: 'DNS Records',  permissionKey: 'dns_records' },
      { to: '/admin/radius',    icon: mdiLockOutline,              label: 'RADIUS / NAC',  permissionKey: 'radius' },
      { to: '/admin/ipam',      icon: mdiIpNetworkOutline,         label: 'IPAM',          permissionKey: 'ipam' },
      { to: '/admin/dhcp',      icon: mdiServerOutline,            label: 'DHCP',          permissionKey: 'dhcp' },
      { to: '/admin/network',   icon: mdiSitemap,                  label: 'Network Infra', permissionKey: 'network' },
      { to: '/admin/phones',    icon: mdiPhoneOutline,             label: 'Phone System',  permissionKey: 'phones' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/roster',       icon: mdiAccountSyncOutline, label: 'Roster Sync',  permissionKey: 'roster' },
      { to: '/admin/bell-schedule', icon: mdiClockOutline,      label: 'Bell Schedule', permissionKey: 'bell_schedule' },
      { to: '/admin/integrations', icon: mdiPuzzleOutline,      label: 'Integrations', permissionKey: 'integrations' },
      { to: '/admin/ha',           icon: mdiSwapHorizontal,     label: 'HA Cluster',   permissionKey: 'ha_monitoring' },
      { to: '/admin/vpn',          icon: mdiVpn,                label: 'VPN',          permissionKey: 'vpn_config' },
      { to: '/admin/ipv6',         icon: mdiTunnelOutline,      label: 'IPv6',         permissionKey: 'ipv6_config' },
      { to: '/admin/ntp',          icon: mdiClockOutline,       label: 'NTP',          permissionKey: 'ntp_monitoring' },
      { to: '/admin/system-health', icon: mdiPulse,             label: 'System Health', permissionKey: 'system_health' },
      { to: '/admin/backup',        icon: mdiBackupRestore,     label: 'Backup & Restore', permissionKey: 'backup_export' },
      { to: '/admin/security-scan', icon: mdiShieldAlertOutline, label: 'Security Scan', permissionKey: 'security_scan' },
      { to: '/admin/reports', icon: mdiClipboardTextMultipleOutline, label: 'Reports', permissionKey: 'reports' },
      { to: '/admin/lost-mode', icon: mdiLaptopOff, label: 'Lost Mode', permissionKey: 'lost_mode' },
      { to: '/admin/settings',     icon: mdiCogOutline,         label: 'Settings',     permissionKey: 'settings' },
      { to: '/admin/custom-roles', icon: mdiAccountKeyOutline,  label: 'Roles & Permissions', superadminOnly: true },
    ],
  },
];

// ---------------------------------------------------------------------------
// NavItem
// ---------------------------------------------------------------------------
function NavItem({ to, icon, label, end = false, badgeCount }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] font-medium transition-all duration-100 ${
          isActive
            ? 'bg-primary-600 text-white shadow-sm'
            : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
        }`
      }
    >
      <Icon path={icon} />
      <span className="flex-1">{label}</span>
      {badgeCount > 0 && (
        <span className="ml-auto bg-amber-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 leading-none">
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      )}
    </NavLink>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export default function Layout() {
  const { user, logout }      = useAuth();
  const { connected, socket } = useSocket();
  const navigate               = useNavigate();
  const isAdmin          = (ROLES[user?.role] ?? 0) >= ROLES.admin;
  const isStaff          = (ROLES[user?.role] ?? 0) >= ROLES.teacher;
  const isSuperAdmin     = user?.role === 'superadmin';

  // Hides admin nav items a custom-role-restricted admin can't actually
  // reach — pure UX (no dead links in the sidebar). The real enforcement is
  // server-side (requirePermission middleware); this never grants access on
  // its own.
  const { data: myPermissions } = useQuery({
    queryKey: ['my-permissions'],
    queryFn:  () => api.get('/users/me/permissions'),
    enabled:  isAdmin,
    staleTime: 60_000,
  });
  const canSee = (item) => {
    if (item.superadminOnly) return isSuperAdmin;
    if (!item.permissionKey) return true;
    if (isSuperAdmin || !myPermissions || myPermissions.unrestricted) return true;
    return myPermissions.permissions?.includes(item.permissionKey);
  };

  // Admins/superadmins who also teach a class have no other way to reach
  // the classroom-only nav (it's otherwise shown only to plain 'teacher'
  // role users) — lets them flip between the two without changing role or
  // re-logging in. Non-admins always get the classroom nav, no switcher
  // shown since they have nothing else to switch to. Per-browser, not
  // per-user — the realistic case is one admin on their own machine.
  const [navView, setNavView] = useState(() => localStorage.getItem('cg_nav_view') || NAV_VIEWS[0].value);
  useEffect(() => {
    localStorage.setItem('cg_nav_view', navView);
  }, [navView]);
  const showTeacherNav = !isAdmin || navView === 'teacher';

  const { data: pendingData } = useQuery({
    queryKey: ['unblock-pending-count'],
    queryFn:  () => api.get('/unblock-requests/pending-count'),
    enabled:  isAdmin,
    refetchInterval: 60_000,
  });
  const pendingCount = pendingData?.count || 0;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-slate-100">

      {/* ---------------------------------------------------------------- */}
      {/* Sidebar                                                           */}
      {/* ---------------------------------------------------------------- */}
      <aside
        className="w-56 flex-shrink-0 flex flex-col overflow-hidden"
        style={{ backgroundColor: '#0f172a' }}
      >
        {/* Logo area */}
        <div className="px-4 py-4 flex-shrink-0" style={{ borderBottom: '1px solid #1e293b' }}>
          {/*
            brightness(0) converts every pixel to black (preserving alpha),
            then invert(1) flips it to white — giving a clean white logo on
            any dark background with zero PNG editing required.
          */}
          <img
            src={logo}
            alt="ClassGuard"
            className="h-8 w-auto object-contain select-none"
            style={{ filter: 'brightness(0) invert(1)' }}
            draggable={false}
          />
          <div className="mt-2.5 flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                connected ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            <span className="text-[11px]" style={{ color: '#475569' }}>
              {connected ? 'Live' : 'Reconnecting…'}
            </span>
          </div>
        </div>

        {/* Nav-view switcher — admins+ only, since a plain teacher has
            nothing else to switch to. A dropdown rather than a fixed
            two-way toggle so a future view is a one-line addition to
            NAV_VIEWS above, not a layout change here. */}
        {isAdmin && (
          <div className="px-3 pt-3 flex-shrink-0">
            <select
              value={navView}
              onChange={e => setNavView(e.target.value)}
              className="w-full bg-slate-800 text-white text-[12px] font-medium rounded-md py-1.5 px-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
            >
              {NAV_VIEWS.map(v => (
                <option key={v.value} value={v.value} className="bg-slate-800 text-white">
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-5">

          {/* Teachers — classroom only (also shown to admins in Teacher view) */}
          {showTeacherNav && (
            <section>
              <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#475569' }}>
                Classroom
              </p>
              <div className="space-y-0.5">
                {TEACHER_NAV.map(item => <NavItem key={item.to} {...item} />)}
              </div>
            </section>
          )}

          {/* Admins — grouped sections */}
          {!showTeacherNav && ADMIN_SECTIONS.map(section => {
            const visibleItems = section.items.filter(canSee);
            if (visibleItems.length === 0) return null;
            return (
              <section key={section.label}>
                <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#475569' }}>
                  {section.label}
                </p>
                <div className="space-y-0.5">
                  {visibleItems.map(item => (
                    <NavItem key={item.to} {...item}
                      badgeCount={item.badge ? pendingCount : 0}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 flex-shrink-0" style={{ borderTop: '1px solid #1e293b' }}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-slate-300 truncate leading-none">
                {user?.given_name || user?.full_name?.split(' ')[0] || user?.email}
              </p>
              <p className="text-[11px] mt-0.5 capitalize" style={{ color: '#475569' }}>
                {user?.role}
              </p>
            </div>
            <button
              onClick={handleLogout}
              title="Sign out"
              className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
            >
              <MdiIcon path={mdiLogoutVariant} size="1.15em" />
            </button>
          </div>
          <p className="mt-2 text-[10px] tabular-nums" style={{ color: '#334155' }}>
            v{VERSION}
          </p>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <ImpersonationBanner user={user} navigate={navigate} />
        {isStaff && <UrgentAlertBanner socket={socket} navigate={navigate} />}
        {isStaff && <FilterBypassBanner socket={socket} navigate={navigate} />}
        {isStaff && <InternetHealthBanner socket={socket} navigate={navigate} />}
        {isSuperAdmin && <HaAutoPromoteBanner socket={socket} navigate={navigate} />}
        <main className="flex-1 overflow-auto bg-slate-100">
          <Outlet />
        </main>
        <ContextualHelpButton navigate={navigate} />
      </div>
    </div>
  );
}
