import { Outlet, NavLink, useNavigate } from 'react-router-dom';
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
} from '@mdi/js';
import logo from '../assets/logo.png';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

const VERSION = '0.0.2';
const ROLES   = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

function Icon({ path }) {
  return <MdiIcon path={path} size="1em" className="flex-shrink-0" />;
}

// ---------------------------------------------------------------------------
// Nav definitions
// ---------------------------------------------------------------------------
const TEACHER_NAV = [
  { to: '/classes',     icon: mdiHomeOutline, label: 'My Classes'  },
  { to: '/penalty-box', icon: mdiFlagOutline,  label: 'Penalty Box' },
];

const ADMIN_SECTIONS = [
  {
    label: 'Overview',
    items: [
      { to: '/admin',                 icon: mdiViewDashboardOutline,   label: 'Dashboard',      end: true },
      { to: '/admin/staff-analytics', icon: mdiChartLine,              label: 'Staff Analytics' },
      { to: '/admin/users',           icon: mdiAccountMultipleOutline, label: 'Users'           },
    ],
  },
  {
    label: 'Policies & Safety',
    items: [
      { to: '/admin/policies',          icon: mdiFileDocumentOutline, label: 'Policies'         },
      { to: '/admin/policy-simulator', icon: mdiFilterOutline,        label: 'Filter Simulator' },
      { to: '/admin/groups',           icon: mdiAccountGroupOutline,  label: 'Groups'           },
      { to: '/admin/blocklists',  icon: mdiShieldOutline,       label: 'Blocklists'    },
      { to: '/admin/categories',  icon: mdiTagOutline,          label: 'Categories'    },
      { to: '/admin/screenshots', icon: mdiCameraOutline,       label: 'Screenshots'   },
      { to: '/admin/ai',          icon: mdiRobotOutline,        label: 'AI Classifier' },
    ],
  },
  {
    label: 'DNS & Network',
    items: [
      { to: '/admin/dns/logs',     icon: mdiFormatListBulletedSquare, label: 'DNS Logs'     },
      { to: '/admin/dns/stats',    icon: mdiChartBar,                 label: 'DNS Stats'    },
      { to: '/admin/dns/records',  icon: mdiDnsOutline,               label: 'DNS Records'  },
      { to: '/admin/radius',    icon: mdiLockOutline,              label: 'RADIUS / NAC'  },
      { to: '/admin/ipam',      icon: mdiIpNetworkOutline,         label: 'IPAM'          },
      { to: '/admin/dhcp',      icon: mdiServerOutline,            label: 'DHCP'          },
      { to: '/admin/network',   icon: mdiSitemap,                  label: 'Network Infra' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/roster',       icon: mdiAccountSyncOutline, label: 'Roster Sync'  },
      { to: '/admin/integrations', icon: mdiPuzzleOutline,      label: 'Integrations' },
      { to: '/admin/ha',           icon: mdiSwapHorizontal,     label: 'HA Cluster'   },
      { to: '/admin/ntp',          icon: mdiClockOutline,       label: 'NTP'          },
      { to: '/admin/settings',     icon: mdiCogOutline,         label: 'Settings'     },
    ],
  },
];

// ---------------------------------------------------------------------------
// NavItem
// ---------------------------------------------------------------------------
function NavItem({ to, icon, label, end = false }) {
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
      <span>{label}</span>
    </NavLink>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export default function Layout() {
  const { user, logout } = useAuth();
  const { connected }    = useSocket();
  const navigate         = useNavigate();
  const isAdmin          = (ROLES[user?.role] ?? 0) >= ROLES.admin;

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

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-5">

          {/* Teachers — classroom only */}
          {!isAdmin && (
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
          {isAdmin && ADMIN_SECTIONS.map(section => (
            <section key={section.label}>
              <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#475569' }}>
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map(item => <NavItem key={item.to} {...item} />)}
              </div>
            </section>
          ))}
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
      <main className="flex-1 overflow-auto bg-slate-100">
        <Outlet />
      </main>
    </div>
  );
}
