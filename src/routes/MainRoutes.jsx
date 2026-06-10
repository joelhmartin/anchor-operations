import { lazy } from 'react';
import { Navigate } from 'react-router-dom';

// project imports
import MainLayout from 'layout/MainLayout';
import Loadable from 'ui-component/Loadable';
import RequireAuth from './RequireAuth';
import SuspendedRoute from 'ui-component/SuspendedRoute';
import useAuth from 'hooks/useAuth';
import Loader from 'ui-component/Loader';
import ErrorBoundary from './ErrorBoundary';

const Operations = Loadable(lazy(() => import('views/admin/Operations')));
const ProfileSettings = Loadable(lazy(() => import('views/admin/ProfileSettings')));

// Operations is admin/superadmin only — SSH access, AI tool execution, and
// ad-platform credentials all live here. Team users are redirected away.
function AdminOnlyRoute({ children }) {
  const { user, initializing } = useAuth();
  if (initializing) return <Loader />;
  const role = user?.effective_role || user?.role;
  return <SuspendedRoute allow={role === 'superadmin' || role === 'admin'}>{children}</SuspendedRoute>;
}

function DefaultLanding() {
  const { user, initializing } = useAuth();
  if (initializing) return <Loader />;
  const role = user?.effective_role || user?.role;
  if (role === 'superadmin' || role === 'admin') {
    return <Navigate to="/operations" replace />;
  }
  // Non-admins have no surface in this app.
  return <Navigate to="/operations" replace />;
}

// ==============================|| MAIN ROUTING ||============================== //

const MainRoutes = {
  path: '/',
  element: (
    <RequireAuth>
      <MainLayout />
    </RequireAuth>
  ),
  errorElement: <ErrorBoundary />,
  children: [
    {
      path: '/',
      element: <DefaultLanding />
    },
    {
      path: 'operations',
      element: (
        <AdminOnlyRoute>
          <Operations />
        </AdminOnlyRoute>
      )
    },
    {
      path: 'profile',
      element: (
        <AdminOnlyRoute>
          <ProfileSettings />
        </AdminOnlyRoute>
      )
    }
  ]
};

export default MainRoutes;
