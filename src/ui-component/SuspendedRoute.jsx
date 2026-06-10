import PropTypes from 'prop-types';
import { Navigate } from 'react-router-dom';

export default function SuspendedRoute({ allow, children }) {
  if (!allow) return <Navigate to="/portal" replace />;
  return children;
}

SuspendedRoute.propTypes = {
  allow: PropTypes.bool,
  children: PropTypes.node
};
