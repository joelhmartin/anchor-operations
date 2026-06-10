import { use } from 'react';

import { AuthContext } from 'contexts/AuthContext';

export default function useAuth() {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider />');
  return ctx;
}
