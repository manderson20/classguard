import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';

// Layout
import Layout from './components/Layout';

// Auth pages
import Login        from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import Setup        from './pages/Setup';
import SetupWizard  from './pages/SetupWizard';

// Teacher pages
import Classes      from './pages/Classes';
import ClassDetail  from './pages/ClassDetail';
import ActiveLesson from './pages/ActiveLesson';
import PenaltyBox      from './pages/PenaltyBox';
import LockdownTests   from './pages/LockdownTests';
import PhoneDirectory  from './pages/PhoneDirectory';

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
import DryRunPage         from './pages/admin/DryRunPage';
import FilterGroupsPage   from './pages/admin/FilterGroupsPage';
import DnsLogs         from './pages/admin/DnsLogs';
import DnsStats        from './pages/admin/DnsStats';
import DnsRecordsPage  from './pages/admin/DnsRecordsPage';
import BrowserHistoryPage from './pages/admin/BrowserHistoryPage';
import BlocklistsPage     from './pages/admin/BlocklistsPage';
import ContentCategories  from './pages/admin/ContentCategories';
import IpamPage        from './pages/admin/IpamPage';
import IpamFullPage    from './pages/admin/IpamFullPage';
import SubnetDetail    from './pages/admin/SubnetDetail';
import DhcpManagement    from './pages/admin/DhcpManagement';
import DhcpV6Management from './pages/admin/DhcpV6Management';
import SettingsPage    from './pages/admin/SettingsPage';
import IntegrationsPage from './pages/admin/IntegrationsPage';
import PhoneSystemPage  from './pages/admin/PhoneSystemPage';
import HaPage          from './pages/admin/HaPage';
import NtpPage         from './pages/admin/NtpPage';
import AiPage          from './pages/admin/AiPage';
import NetworkPage     from './pages/admin/NetworkPage';
import NetworkToolsPage from './pages/admin/NetworkToolsPage';
import NetworkDeviceDetail from './pages/admin/NetworkDeviceDetail';
import SystemHealthPage from './pages/admin/SystemHealthPage';
import RosterPage          from './pages/admin/RosterPage';
import RadiusPage          from './pages/admin/RadiusPage';
import ScreenshotsPage     from './pages/admin/ScreenshotsPage';
import SafetyAlertsPage    from './pages/admin/SafetyAlertsPage';
import ChatAuditPage       from './pages/admin/ChatAuditPage';
import DeviceViewAuditPage from './pages/admin/DeviceViewAuditPage';
import ImpersonationAuditPage from './pages/admin/ImpersonationAuditPage';
import BackupPage          from './pages/admin/BackupPage';
import SecurityScanPage    from './pages/admin/SecurityScanPage';
import ReportsPage         from './pages/admin/ReportsPage';
import LostModePage        from './pages/admin/LostModePage';
import FilterBypassPage    from './pages/admin/FilterBypassPage';
import HelpCenterPage      from './pages/admin/HelpCenterPage';
import VpnPage             from './pages/admin/VpnPage';
import StaffAnalyticsPage  from './pages/admin/StaffAnalyticsPage';
import ScreenTimePage      from './pages/admin/ScreenTimePage';
import BellSchedulePage    from './pages/admin/BellSchedulePage';
import InfosecIqDashboard      from './pages/admin/infoseciq/InfosecIqDashboard';
import InfosecIqLearners       from './pages/admin/infoseciq/InfosecIqLearners';
import InfosecIqCampaigns      from './pages/admin/infoseciq/InfosecIqCampaigns';
import InfosecIqCampaignDetail from './pages/admin/infoseciq/InfosecIqCampaignDetail';
import InfosecIqGradeCards     from './pages/admin/infoseciq/InfosecIqGradeCards';

// ClassPulse
import ClassPulseHub      from './pages/classpulse/ClassPulseHub';
import LessonLibrary      from './pages/classpulse/LessonLibrary';
import LessonBuilder      from './pages/classpulse/LessonBuilder';
import TeachSession       from './pages/classpulse/TeachSession';
import StudentJoin        from './pages/classpulse/StudentJoin';
import ClassPulseAdminPage from './pages/admin/ClassPulseAdminPage';

// Fleet pages
import FleetOverview    from './pages/fleet/FleetOverview';
import FleetDevices     from './pages/fleet/FleetDevices';
import FleetChromebooks from './pages/fleet/FleetChromebooks';
import FleetApple       from './pages/fleet/FleetApple';
import FleetCrossSync   from './pages/fleet/FleetCrossSync';
import FleetOffline     from './pages/fleet/FleetOffline';
import FleetLifecycle   from './pages/fleet/FleetLifecycle';

const ROLES = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

function RequireAuth({ children, minRole = 'teacher' }) {
  const { user, loading } = useAuth();
  const location = useLocation();

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

  // Redirect superadmins through the setup wizard on first login
  if (user.role === 'superadmin' && !user.wizardComplete && location.pathname !== '/wizard') {
    return <Navigate to="/wizard" replace />;
  }

  return children;
}

function DefaultRedirect() {
  return <Navigate to="/classes" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/setup"          element={<Setup />} />
      <Route path="/login"         element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      {/* First-time setup wizard — requires auth but bypasses Layout */}
      <Route path="/wizard" element={<RequireAuth minRole="superadmin"><SetupWizard /></RequireAuth>} />

      <Route element={<RequireAuth minRole="teacher"><Layout /></RequireAuth>}>
        <Route index element={<DefaultRedirect />} />

        <Route element={<RequireAuth minRole="teacher"><Outlet /></RequireAuth>}>
          <Route path="/classes"                 element={<Classes />} />
          <Route path="/classes/:classId"        element={<ClassDetail />} />
          <Route path="/classes/:classId/lesson" element={<ActiveLesson />} />
          <Route path="/penalty-box"             element={<PenaltyBox />} />
          <Route path="/phone-directory"         element={<PhoneDirectory />} />
          <Route path="/lockdown"                element={<LockdownTests />} />
          <Route path="/help"                    element={<HelpCenterPage />} />
          <Route path="/help/:slug"              element={<HelpCenterPage />} />
          {/* ClassPulse — teacher-accessible */}
          <Route path="/classpulse"                      element={<ClassPulseHub />} />
          <Route path="/classpulse/lessons"              element={<LessonLibrary />} />
          <Route path="/classpulse/lessons/new"          element={<LessonBuilder />} />
          <Route path="/classpulse/lessons/:id/edit"     element={<LessonBuilder />} />
          <Route path="/classpulse/sessions/:id/teach"   element={<TeachSession />} />
        </Route>

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
          <Route path="/admin/filter-groups"          element={<FilterGroupsPage />} />
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
          <Route path="/admin/dhcpv6"                element={<DhcpV6Management />} />
          <Route path="/admin/integrations"           element={<IntegrationsPage />} />
          <Route path="/admin/ha"                     element={<HaPage />} />
          <Route path="/admin/ntp"                    element={<NtpPage />} />
          <Route path="/admin/ai"                     element={<AiPage />} />
          <Route path="/admin/network"                element={<NetworkPage />} />
          <Route path="/admin/network/device/:mac"    element={<NetworkDeviceDetail />} />
          <Route path="/admin/network-tools"           element={<NetworkToolsPage />} />
          <Route path="/admin/roster"                 element={<RosterPage />} />
          <Route path="/admin/radius"                 element={<RadiusPage />} />
          <Route path="/admin/screenshots"            element={<ScreenshotsPage />} />
          <Route path="/admin/safety-alerts"          element={<SafetyAlertsPage />} />
          <Route path="/admin/chat"                   element={<ChatAuditPage />} />
          <Route path="/admin/device-view-audit"      element={<DeviceViewAuditPage />} />
          <Route path="/admin/impersonation-audit"    element={<ImpersonationAuditPage />} />
          <Route path="/admin/backup"                 element={<BackupPage />} />
          <Route path="/admin/security-scan"          element={<SecurityScanPage />} />
          <Route path="/admin/classpulse"             element={<ClassPulseAdminPage />} />
          <Route path="/admin/reports"                element={<ReportsPage />} />
          <Route path="/admin/lost-mode"               element={<LostModePage />} />
          <Route path="/admin/filter-bypass"           element={<FilterBypassPage />} />
          <Route path="/admin/settings"               element={<SettingsPage />} />
          <Route path="/admin/system-health"           element={<SystemHealthPage />} />
          <Route path="/admin/vpn"                    element={<VpnPage />} />
          {/* Dry run — all admins can view status; superadmin controls are
              gated inside DryRunPage itself, so the route is admin-readable */}
          <Route path="/admin/dry-run"              element={<DryRunPage />} />

          {/* Superadmin-only: managing what a role grants is itself
              adjacent to privilege escalation, same tier as role assignment */}
          <Route element={<RequireAuth minRole="superadmin"><Outlet /></RequireAuth>}>
            <Route path="/admin/custom-roles"         element={<CustomRolesPage />} />
          </Route>

          {/* Device Fleet */}
          <Route path="/fleet"              element={<FleetOverview />} />
          <Route path="/fleet/devices"      element={<FleetDevices />} />
          <Route path="/fleet/chromebooks"  element={<FleetChromebooks />} />
          <Route path="/fleet/apple"        element={<FleetApple />} />
          <Route path="/fleet/cross-sync"   element={<FleetCrossSync />} />
          <Route path="/fleet/offline"      element={<FleetOffline />} />
          <Route path="/fleet/lifecycle"    element={<FleetLifecycle />} />

          {/* Infosec IQ */}
          <Route path="/admin/infoseciq"                    element={<InfosecIqDashboard />} />
          <Route path="/admin/infoseciq/learners"           element={<InfosecIqLearners />} />
          <Route path="/admin/infoseciq/campaigns"          element={<InfosecIqCampaigns />} />
          <Route path="/admin/infoseciq/campaigns/:id"      element={<InfosecIqCampaignDetail />} />
          <Route path="/admin/infoseciq/grade-cards"        element={<InfosecIqGradeCards />} />
        </Route>
      </Route>

      {/* Public student join page — outside RequireAuth, works on any Chromebook */}
      <Route path="/pulse/:code" element={<StudentJoin />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
