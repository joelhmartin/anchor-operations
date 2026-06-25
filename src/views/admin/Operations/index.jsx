/**
 * Operations shell — client-first IA.
 *
 * Three views (Home · Clients · Portfolio) selected from the app sidebar.
 * State is query-param-driven: ?view=&clientUserId=&section=
 * Context: OpsWorkspaceContext (client roster, activeClient, nav helpers).
 */

import { Suspense, lazy } from 'react';
import { Box, CircularProgress } from '@mui/material';
import MainCard from 'ui-component/cards/MainCard';
import { OpsWorkspaceProvider, useOpsWorkspace } from './OpsWorkspaceContext';
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

  // Clients is a full-height two-column layout (roster + workspace), flush to the card edges.
  if (view === 'clients') {
    return (
      <Box sx={{ display: 'flex', height: 'calc(100vh - 200px)', minHeight: 480 }}>
        <ClientRoster />
        <ClientWorkspace />
      </Box>
    );
  }

  // Home and Portfolio are padded single-column views.
  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Suspense fallback={<LazyFallback />}>{view === 'portfolio' ? <PortfolioView /> : <HomeDigest />}</Suspense>
    </Box>
  );
}

export default function Operations() {
  return (
    <MainCard title="Operations" content={false}>
      <OpsWorkspaceProvider>
        <WorkspaceBody />
      </OpsWorkspaceProvider>
    </MainCard>
  );
}
