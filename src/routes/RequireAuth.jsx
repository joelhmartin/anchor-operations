import PropTypes from 'prop-types';
import { Navigate, useLocation } from 'react-router-dom';

import Loader from 'ui-component/Loader';
import useAuth from 'hooks/useAuth';

export default function RequireAuth({ children }) {
  const { user, initializing } = useAuth();
  const location = useLocation();

  if (initializing) return <Loader />;
  if (!user) {
    return <Navigate to="/pages/login" state={{ from: location }} replace />;
  }

  return children;
}

RequireAuth.propTypes = {
  children: PropTypes.node
};
