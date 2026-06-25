import { IconHome, IconUsers, IconLayoutGrid, IconSettings } from '@tabler/icons-react';

// The Operations app is a single page whose view is driven by `?view=`.
// Each Operations nav item points at the same route with a different view and
// highlights based on the active `?view=` (Home is also active on bare /operations).
const opsViewActive = (view) => ({ pathname, search }) => {
  if (pathname !== '/operations') return false;
  const current = new URLSearchParams(search || '').get('view') || 'home';
  return current === view;
};

export const adminNavGroup = {
  id: 'admin-nav-group',
  title: 'Operations',
  type: 'group',
  children: [
    {
      id: 'operations-home',
      title: 'Home',
      type: 'item',
      url: '/operations?view=home',
      icon: IconHome,
      isActive: opsViewActive('home')
    },
    {
      id: 'operations-clients',
      title: 'Clients',
      type: 'item',
      url: '/operations?view=clients',
      icon: IconUsers,
      isActive: opsViewActive('clients')
    },
    {
      id: 'operations-portfolio',
      title: 'Portfolio',
      type: 'item',
      url: '/operations?view=portfolio',
      icon: IconLayoutGrid,
      isActive: opsViewActive('portfolio')
    },
    {
      id: 'profile-settings',
      title: 'Profile Settings',
      type: 'item',
      url: '/profile',
      icon: IconSettings
    }
  ]
};
