import { useState } from 'react';
import { Box, Tabs, Tab, Typography, Menu, MenuItem, Button } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { useOpsWorkspace, CLIENT_SECTIONS, CONFIG_SECTIONS } from '../OpsWorkspaceContext';
import { clientLabel } from '../_clientLabel';
import EmptyState from 'ui-component/extended/EmptyState';
import DiscoveriesTab from '../Discoveries/DiscoveriesTab';
import ContentTab from '../Content/ContentTab';
import ClientChat from '../Chat/ClientChat';
import ClientSitesPanel from './ClientSitesPanel';
import ClientOverview from './ClientOverview';
import ClientOpsView from './ClientOpsView';
import ClientConnectionsPanel from './ClientConnectionsPanel';
import ClientAgentProfileEditor from './ClientAgentProfileEditor';

function SectionBody({ section, clientUserId, activeClient, setSection }) {
  switch (section) {
    case 'overview':
      return <ClientOverview clientUserId={clientUserId} />;
    case 'findings':
      return <DiscoveriesTab activeClientId={clientUserId} onOpenDiscovery={() => {}} onOpenRun={() => {}} />;
    case 'socials':
      return <ContentTab activeClientId={clientUserId} mode="social" />;
    case 'blog':
      return <ContentTab activeClientId={clientUserId} mode="blog" />;
    case 'chat':
      return <ClientChat lockedClientUserId={clientUserId} />;
    case 'sites':
      return <ClientSitesPanel clientUserId={clientUserId} />;
    case 'connections':
      return <ClientConnectionsPanel clientUserId={clientUserId} />;
    case 'health':
    case 'runs':
    case 'cost':
      return (
        <ClientOpsView
          clientUserId={clientUserId}
          clientName={clientLabel(activeClient)}
          onOpenChat={() => setSection('chat')}
          onOpenRun={() => setSection('runs')}
        />
      );
    case 'agent_profile':
      return <ClientAgentProfileEditor clientUserId={clientUserId} />;
    default:
      return <EmptyState title="Coming up" message={`The "${section}" section renders here.`} />;
  }
}

export default function ClientWorkspace() {
  const { activeClient, section, setSection } = useOpsWorkspace();
  const [anchorEl, setAnchorEl] = useState(null);

  if (!activeClient) {
    return (
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
        <EmptyState title="Pick a client" message="Choose a client from the roster to open their workspace." />
      </Box>
    );
  }

  const inConfig = CONFIG_SECTIONS.some((s) => s.value === section);
  const primaryValue = inConfig ? false : section;

  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ px: 3, pt: 2.5, pb: 1 }}>
        <Typography variant="h3">{clientLabel(activeClient)}</Typography>
      </Box>
      <Box sx={{ px: 3, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 1 }}>
        <Tabs value={primaryValue} onChange={(_, v) => setSection(v)} variant="scrollable" scrollButtons="auto">
          {CLIENT_SECTIONS.map((s) => (
            <Tab key={s.value} value={s.value} label={s.label} />
          ))}
        </Tabs>
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<SettingsIcon />} onClick={(e) => setAnchorEl(e.currentTarget)}>
          Config
        </Button>
        <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
          {CONFIG_SECTIONS.map((s) => (
            <MenuItem
              key={s.value}
              selected={section === s.value}
              onClick={() => {
                setSection(s.value);
                setAnchorEl(null);
              }}
            >
              {s.label}
            </MenuItem>
          ))}
        </Menu>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 3 }}>
        <SectionBody section={section} clientUserId={activeClient.id} activeClient={activeClient} setSection={setSection} key={`${activeClient.id}:${section}`} />
      </Box>
    </Box>
  );
}
