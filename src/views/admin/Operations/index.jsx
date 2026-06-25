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

import { Suspense, lazy } from 'react';
import { Box, CircularProgress } from '@mui/material';
import MainCard from 'ui-component/cards/MainCard';
import { OpsWorkspaceProvider, useOpsWorkspace } from './OpsWorkspaceContext';
import WorkspaceRail from './WorkspaceRail';
import ClientRoster from './Clients/ClientRoster';
import ClientWorkspace from './Clients/ClientWorkspace';

const CommandCenterTab = lazy(() => import('./CommandCenter/CommandCenterTab'));
const BulkTab = lazy(() => import('./Bulk/BulkTab'));

function LazyFallback() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
      <CircularProgress size={28} />
    </Box>
  );
}

function WorkspaceBody() {
  const { view, setView, setClientUserId, setSection } = useOpsWorkspace();

  // Deep-link helpers reused by Home (Task 5): jump straight to a client section.
  const openClientSection = (clientUserId, section) => {
    setClientUserId(clientUserId);
    setSection(section);
  };

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 160px)', minHeight: 480 }}>
      <WorkspaceRail />
      {view === 'home' && (
        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', p: 2 }}>
          <Suspense fallback={<LazyFallback />}>
            <CommandCenterTab
              onOpenDiscovery={() => setView('clients')}
              onOpenDiscoveriesFiltered={(f) => f?.client_user_id && openClientSection(f.client_user_id, 'findings')}
            />
          </Suspense>
        </Box>
      )}
      {view === 'clients' && (
        <>
          <ClientRoster />
          <ClientWorkspace />
        </>
      )}
      {view === 'portfolio' && (
        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', p: 2 }}>
          <Suspense fallback={<LazyFallback />}>
            <BulkTab />
          </Suspense>
        </Box>
      )}
    </Box>
  );
}

export default function Operations() {
  return (
    <MainCard title="Operations" content={false} sx={{ '& .MuiCardContent-root': { p: 0 } }}>
      <OpsWorkspaceProvider>
        <WorkspaceBody />
      </OpsWorkspaceProvider>
    </MainCard>
  );
}
