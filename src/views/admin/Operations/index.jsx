/**
 * Operations shell — Command Center pivot IA.
 *
 * Four top-level tabs: Command Center · Discoveries · Agent · Bulk.
 * Clients and Connections tabs were removed — the Agent tab handles
 * per-client work with a platform selector, and Bulk covers the
 * operational run management previously split across Connections.
 *
 * Back-compat: the previous tab URLs resolve into the new tabs via the
 * alias map below — bookmarks and deep-links from the prior IA continue to work.
 */

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Box, CircularProgress, Stack, Tab, Tabs } from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import ChatIcon from '@mui/icons-material/Chat';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import MainCard from 'ui-component/cards/MainCard';
import useAuth from 'hooks/useAuth';
import ClientChat from './Chat/ClientChat';

const CommandCenterTab = lazy(() => import('./CommandCenter/CommandCenterTab'));
const DiscoveriesTab = lazy(() => import('./Discoveries/DiscoveriesTab'));
const BulkTab = lazy(() => import('./Bulk/BulkTab'));
const ContentTab = lazy(() => import('./Content/ContentTab'));

const WORKSPACE_TABS = [
  { value: 'command-center', label: 'Command Center', Icon: DashboardIcon },
  { value: 'discoveries', label: 'Discoveries', Icon: ReportProblemIcon },
  { value: 'agent', label: 'Agent', Icon: ChatIcon },
  { value: 'bulk', label: 'Bulk', Icon: PlayCircleOutlineIcon },
  { value: 'content', label: 'Content', Icon: EditCalendarIcon }
];

// Back-compat aliases — pre-pivot URLs land on the right new tab and, where
// applicable, set the section selector.
const TAB_ALIASES = {
  overview: { tab: 'command-center' },
  findings: { tab: 'discoveries' },
  chat: { tab: 'agent' },
  clients: { tab: 'agent' },
  runs: { tab: 'bulk', section: 'runs' },
  schedule: { tab: 'bulk', section: 'schedules' },
  cost: { tab: 'command-center' },
  sites: { tab: 'command-center' },
  connections: { tab: 'bulk' },
  bulk: { tab: 'bulk' }
};

function TabPanel({ activeTab, value, children }) {
  if (activeTab !== value) return null;
  return <Box sx={{ pt: 2 }}>{children}</Box>;
}

function LazyFallback() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
      <CircularProgress size={28} />
    </Box>
  );
}

export default function Operations() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const role = user?.effective_role || user?.role;
  const canManageOperations = role === 'superadmin' || role === 'admin';

  const requestedTab = searchParams.get('tab') || 'command-center';
  const alias = TAB_ALIASES[requestedTab];
  const resolvedTab = alias?.tab || requestedTab;
  const activeTab = WORKSPACE_TABS.some((tab) => tab.value === resolvedTab) ? resolvedTab : 'command-center';

  // If we hit an alias, rewrite the URL once so future state stays consistent.
  useEffect(() => {
    if (!alias) return;
    const next = new URLSearchParams(searchParams);
    next.set('tab', alias.tab);
    if (alias.section && !next.get('section')) next.set('section', alias.section);
    setSearchParams(next, { replace: true });
  }, [alias]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestedClientUserId = searchParams.get('clientUserId') || null;

  const [pendingClientForChat, setPendingClientForChat] = useState(requestedClientUserId);

  useEffect(() => {
    setPendingClientForChat(requestedClientUserId);
  }, [requestedClientUserId]);

  const handleTabChange = useCallback(
    (_, nextTab) => {
      const next = new URLSearchParams(searchParams);
      next.set('tab', nextTab);
      // Drop section when leaving Bulk so re-entering starts fresh.
      if (nextTab !== 'bulk') next.delete('section');
      if (nextTab === 'discoveries') {
        next.delete('severity');
        next.delete('status');
        next.delete('discovery');
        next.delete('client_user_id');
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const switchTab = useCallback(
    (tab, extras = {}) => {
      const next = new URLSearchParams(searchParams);
      next.set('tab', tab);
      for (const [k, v] of Object.entries(extras)) {
        if (v == null) next.delete(k);
        else next.set(k, v);
      }
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams]
  );

  const openDiscovery = useCallback(
    (discoveryId) => {
      switchTab('discoveries', { discovery: discoveryId });
    },
    [switchTab]
  );

  const openDiscoveriesFiltered = useCallback(
    (filters = {}) => {
      switchTab('discoveries', filters);
    },
    [switchTab]
  );

  if (!canManageOperations) {
    return <Alert severity="info">Operations is only available to admins.</Alert>;
  }

  return (
    <MainCard title="Operations">
      <Stack spacing={2}>
        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          {WORKSPACE_TABS.map((tab) => (
            <Tab key={tab.value} value={tab.value} label={tab.label} icon={<tab.Icon />} iconPosition="start" />
          ))}
        </Tabs>

        <Suspense fallback={<LazyFallback />}>
          <TabPanel activeTab={activeTab} value="command-center">
            <CommandCenterTab onOpenDiscovery={openDiscovery} onOpenDiscoveriesFiltered={openDiscoveriesFiltered} />
          </TabPanel>
          <TabPanel activeTab={activeTab} value="discoveries">
            <DiscoveriesTab onOpenDiscovery={openDiscovery} />
          </TabPanel>
          <TabPanel activeTab={activeTab} value="agent">
            <ClientChat initialClientUserId={pendingClientForChat || requestedClientUserId} />
          </TabPanel>
          <TabPanel activeTab={activeTab} value="bulk">
            <BulkTab />
          </TabPanel>
          <TabPanel activeTab={activeTab} value="content">
            <ContentTab />
          </TabPanel>
        </Suspense>
      </Stack>
    </MainCard>
  );
}
