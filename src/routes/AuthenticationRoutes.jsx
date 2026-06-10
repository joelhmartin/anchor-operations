import { lazy } from 'react';

// project imports
import Loadable from 'ui-component/Loadable';
import MinimalLayout from 'layout/MinimalLayout';
import ErrorBoundary from './ErrorBoundary';

const LoginPage = Loadable(lazy(() => import('views/pages/authentication/Login')));
const ForgotPasswordPage = Loadable(lazy(() => import('views/pages/authentication/ForgotPassword')));

// ==============================|| AUTHENTICATION ROUTING ||============================== //

const AuthenticationRoutes = {
  path: '/',
  element: <MinimalLayout />,
  errorElement: <ErrorBoundary />,
  children: [
    {
      path: '/pages/login',
      element: <LoginPage />
    },
    {
      path: '/pages/forgot-password',
      element: <ForgotPasswordPage />
    }
  ]
};

export default AuthenticationRoutes;
