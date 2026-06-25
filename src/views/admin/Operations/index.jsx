/**
 * Operations shell — client-first left-rail IA.
 *
 * Three views (left rail): Home · Clients · Portfolio.
 * State is query-param-driven: ?view=&clientUserId=&section=
 * Context: OpsWorkspaceContext (client roster, activeClient, nav helpers).
 */

import { Suspense, lazy } from 'react';
import { Box, CircularProgress } from '@mui/material';
import MainCard from 'ui-component/cards/MainCard';
import { OpsWorkspaceProvider, useOpsWorkspace } from './OpsWorkspaceContext';
import WorkspaceRail from './WorkspaceRail';
import ClientRoster from './Clients/ClientRoster';
import ClientWorkspace from './Clients/ClientWorkspace';

const HomeDigest = lazy(() => import('./home/HomeDigest'));
const PortfolioView = lazy(() => import('./portfolio/PortfolioView'));

function LazyFallback() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
      <CircularProgress size={28} />
    </Box>
  );
}

function WorkspaceBody() {
  const { view } = useOpsWorkspace();

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 160px)', minHeight: 480 }}>
      <WorkspaceRail />
      {view === 'home' && (
        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', p: 2 }}>
          <Suspense fallback={<LazyFallback />}>
            <HomeDigest />
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
            <PortfolioView />
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
