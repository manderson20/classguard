import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

const TEACHER_NAV = [
  { to: '/classes',     icon: '🏫', label: 'My Classes' },
  { to: '/penalty-box', icon: '⚠️', label: 'Penalty Box' },
];

const ADMIN_NAV = [
  { to: '/admin',                icon: '📊', label: 'Dashboard' },
  { to: '/admin/users',          icon: '👥', label: 'Users' },
  { to: '/admin/policies',       icon: '📋', label: 'Policies' },
  { to: '/admin/groups',         icon: '🔗', label: 'Groups' },
  { to: '/admin/dns/logs',       icon: '🌐', label: 'DNS Logs' },
  { to: '/admin/dns/stats',      icon: '📈', label: 'DNS Stats' },
  { to: '/admin/blocklists',     icon: '🛡️', label: 'Blocklists' },
  { to: '/admin/ipam',           icon: '🗺️', label: 'IPAM' },
  { to: '/admin/dhcp',           icon: '📡', label: 'DHCP' },
  { to: '/admin/integrations',   icon: '🔌', label: 'Integrations' },
  { to: '/admin/ntp',            icon: '🕐', label: 'NTP' },
  { to: '/admin/ha',             icon: '🔄', label: 'HA Cluster' },
  { to: '/admin/settings',       icon: '⚙️', label: 'Settings' },
];

const ROLES = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

function NavItem({ to, icon, label, end = false }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
         ${isActive
           ? 'bg-primary-600 text-white'
           : 'text-primary-100 hover:bg-primary-600/50 hover:text-white'}`
      }
    >
      <span className="text-base leading-none">{icon}</span>
      {label}
    </NavLink>
  );
}

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
    <div className="flex h-screen bg-slate-50">
      {/* Sidebar */}
      <aside className="w-52 flex-shrink-0 bg-primary-700 text-white flex flex-col overflow-y-auto">
        {/* Logo */}
        <div className="px-4 py-4 border-b border-primary-600 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xl">🛡️</span>
            <div>
              <div className="font-bold text-sm leading-tight">ClassGuard</div>
              <div className="text-xs text-primary-300 capitalize">{user?.role ?? ''}</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {/* Teacher section — always visible for teacher+ */}
          <p className="px-3 pt-2 pb-1 text-xs font-semibold text-primary-400 uppercase tracking-wider">
            Classroom
          </p>
          {TEACHER_NAV.map(item => <NavItem key={item.to} {...item} />)}

          {/* Admin section */}
          {isAdmin && (
            <>
              <p className="px-3 pt-4 pb-1 text-xs font-semibold text-primary-400 uppercase tracking-wider">
                Administration
              </p>
              {ADMIN_NAV.map(item => (
                <NavItem key={item.to} {...item} end={item.to === '/admin'} />
              ))}
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="px-3 py-3 border-t border-primary-600 flex-shrink-0 space-y-2">
          <div className="flex items-center gap-1.5 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-yellow-400'}`} />
            <span className="text-primary-300">{connected ? 'Live' : 'Polling'}</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white truncate">
                {user?.given_name || user?.full_name?.split(' ')[0] || user?.email}
              </div>
            </div>
            <button onClick={handleLogout} className="text-xs text-primary-300 hover:text-white ml-2" title="Sign out">
              ↩
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
