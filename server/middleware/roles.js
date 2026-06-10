export function requireRole(roles = []) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Login required' });
    const role = req.user.effective_role || req.user.role;
    if (!roles.includes(role)) return res.status(403).json({ message: 'Insufficient permissions' });
    next();
  };
}

export const isAdmin = requireRole(['superadmin', 'admin']);
export const isAdminOrEditor = requireRole(['superadmin', 'admin', 'editor']);
export const isStaff = requireRole(['superadmin', 'admin', 'team']);
