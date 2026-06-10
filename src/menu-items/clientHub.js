import { IconSettings, IconStack2 } from '@tabler/icons-react';

export const adminNavGroup = {
  id: 'admin-nav-group',
  title: 'Operations',
  type: 'group',
  children: [
    {
      id: 'operations',
      title: 'Operations',
      type: 'item',
      url: '/operations',
      icon: IconStack2
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
