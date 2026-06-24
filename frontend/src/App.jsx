import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';

// Layout
import Layout from './components/Layout';

// Auth pages
import Login        from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import Setup        from './pages/Setup';

// Teacher pages
import Classes      from './pages/Classes';
import ClassDetail  from './pages/ClassDetail';
import ActiveLesson from './pages/ActiveLesson';
import PenaltyBox   from './pages/PenaltyBox';
import LockdownTests from './pages/LockdownTests';

// Admin pages
import AdminDashboard  from './pages/admin/AdminDashboard';
import UsersPage       from './pages/admin/UsersPage';
import UserDetail      from './pages/admin/UserDetail';
import PoliciesPage      from './pages/admin/PoliciesPage';
import PolicyEditor      from './pages/admin/PolicyEditor';
import PolicySimulator     from './pages/admin/PolicySimulator';
import UnblockRequestsPage from './pages/admin/UnblockRequestsPage';
import GroupsPage          from './pages/admin/GroupsPage';
import CustomRolesPage     from './pages/admin/CustomRolesPage';
import DnsLogs         from './pages/admin/DnsLogs';
import DnsStats        from './pages/admin/DnsStats';
import DnsRecordsPage  from './pages/admin/DnsRecordsPage';
import BrowserHistoryPage from './pages/admin/BrowserHistoryPage';
import BlocklistsPage     from './pages/admin/BlocklistsPage';
import ContentCategories  from './pages/admin/ContentCategories';
import IpamPage        from './pages/admin/IpamPage';
import IpamFullPage    from './pages/admin/IpamFullPage';
import SubnetDetail    from './pages/admin/SubnetDetail';
import DhcpManagement  from './pages/admin/DhcpManagement';
import SettingsPage    from './pages/admin/SettingsPage';
import IntegrationsPage from './pages/admin/IntegrationsPage';
import PhoneSystemPage  from './pages/admin/PhoneSystemPage';
import HaPage          from './pages/admin/HaPage';
import NtpPage         from './pages/admin/NtpPage';
import AiPage          from './pages/admin/AiPage';
import NetworkPage     from './pages/admin/NetworkPage';
import NetworkDeviceDetail from './pages/admin/NetworkDeviceDetail';
import SystemHealthPage from './pages/admin/SystemHealthPage';
import RosterPage          from './pages/admin/RosterPage';
import RadiusPage          from './pages/admin/RadiusPage';
import ScreenshotsPage     from './pages/admin/ScreenshotsPage';
import SafetyAlertsPage    from './pages/admin/SafetyAlertsPage';
import ChatAuditPage       from './pages/admin/ChatAuditPage';
import DeviceViewAuditPage from './pages/admin/DeviceViewAuditPage';
import VpnPage             from './pages/admin/VpnPage';
import Ipv6Page             from './pages/admin/Ipv6Page';
import StaffAnalyticsPage  from './pages/admin/StaffAnalyticsPage';
import ScreenTimePage      from './pages/admin/ScreenTimePage';
import BellSchedulePage    from './pages/admin/BellSchedulePage';

const ROLES = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

function RequireAuth({ children, minRole = 'teacher' }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-slate-400 text-sm">Loading…</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if ((ROLES[user.role] ?? 0) < (ROLES[minRole] ?? 0)) {
    return <Navigate to="/login?error=insufficient_role" replace />;
  }

  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/setup"          element={<Setup />} />
      <Route path="/login"         element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      {/* Teacher + Admin shared layout */}
      <Route element={<RequireAuth minRole="teacher"><Layout /></RequireAuth>}>
        <Route index element={<Navigate to="/classes" replace />} />

        {/* Teacher routes */}
        <Route path="/classes"                 element={<Classes />} />
        <Route path="/classes/:classId"        element={<ClassDetail />} />
        <Route path="/classes/:classId/lesson" element={<ActiveLesson />} />
        <Route path="/penalty-box"             element={<PenaltyBox />} />
        <Route path="/lockdown"                element={<LockdownTests />} />

        {/* Admin routes */}
        <Route element={<RequireAuth minRole="admin"><Outlet /></RequireAuth>}>
          <Route path="/admin"                        element={<AdminDashboard />} />
          <Route path="/admin/staff-analytics"        element={<StaffAnalyticsPage />} />
          <Route path="/admin/screen-time"            element={<ScreenTimePage />} />
          <Route path="/admin/bell-schedule"          element={<BellSchedulePage />} />
          <Route path="/admin/users"                  element={<UsersPage />} />
          <Route path="/admin/users/:userId"          element={<UserDetail />} />
          <Route path="/admin/policies"               element={<PoliciesPage />} />
          <Route path="/admin/policies/:policyId"     element={<PolicyEditor />} />
          <Route path="/admin/policy-simulator"        element={<PolicySimulator />} />
          <Route path="/admin/unblock-requests"        element={<UnblockRequestsPage />} />
          <Route path="/admin/groups"                 element={<GroupsPage />} />
          <Route path="/admin/dns/logs"               element={<DnsLogs />} />
          <Route path="/admin/dns/stats"              element={<DnsStats />} />
          <Route path="/admin/dns/records"            element={<DnsRecordsPage />} />
          <Route path="/admin/browser-history"        element={<BrowserHistoryPage />} />
          <Route path="/admin/blocklists"             element={<BlocklistsPage />} />
          <Route path="/admin/categories"            element={<ContentCategories />} />
          <Route path="/admin/ipam"                   element={<IpamFullPage />} />
          <Route path="/admin/ipam/subnets"           element={<IpamPage />} />
          <Route path="/admin/ipam/subnets/:subnetId" element={<SubnetDetail />} />
          <Route path="/admin/phones"                 element={<PhoneSystemPage />} />
          <Route path="/admin/dhcp"                   element={<DhcpManagement />} />
          <Route path="/admin/integrations"           element={<IntegrationsPage />} />
          <Route path="/admin/ha"                     element={<HaPage />} />
          <Route path="/admin/ntp"                    element={<NtpPage />} />
          <Route path="/admin/ai"                     element={<AiPage />} />
          <Route path="/admin/network"                element={<NetworkPage />} />
          <Route path="/admin/network/device/:mac"    element={<NetworkDeviceDetail />} />
          <Route path="/admin/roster"                 element={<RosterPage />} />
          <Route path="/admin/radius"                 element={<RadiusPage />} />
          <Route path="/admin/screenshots"            element={<ScreenshotsPage />} />
          <Route path="/admin/safety-alerts"          element={<SafetyAlertsPage />} />
          <Route path="/admin/chat"                   element={<ChatAuditPage />} />
          <Route path="/admin/device-view-audit"      element={<DeviceViewAuditPage />} />
          <Route path="/admin/settings"               element={<SettingsPage />} />
          <Route path="/admin/system-health"           element={<SystemHealthPage />} />
          <Route path="/admin/vpn"                    element={<VpnPage />} />
          <Route path="/admin/ipv6"                   element={<Ipv6Page />} />

          {/* Superadmin-only: managing what a role grants is itself
              adjacent to privilege escalation, same tier as role assignment */}
          <Route element={<RequireAuth minRole="superadmin"><Outlet /></RequireAuth>}>
            <Route path="/admin/custom-roles"         element={<CustomRolesPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
