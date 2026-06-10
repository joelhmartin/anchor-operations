import { useEffect, useState, useCallback } from 'react';
import {
  Box,
  Drawer,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Tab,
  Tabs,
  Typography
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import StatusChip from 'ui-component/extended/StatusChip';
import { useToast } from 'contexts/ToastContext';
import { fetchOperationsSite, setEnvReadOnly } from 'api/operations';
import SiteTerminal from './SiteTerminal';
import SiteWorkspaceEditor from './SiteWorkspaceEditor';
import SiteClientLinks from './SiteClientLinks';
import SiteCommandHistory from './SiteCommandHistory';
import SiteAssistant from './SiteAssistant';
import SiteFindings from './SiteFindings';

const SUB_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'findings', label: 'Findings' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'workspace', label: 'Workspace' },
  { value: 'clients', label: 'Linked Clients' },
  { value: 'history', label: 'History' }
];

function Overview({ detail, onChange }) {
  const { showToast: toast } = useToast();
  if (!detail) return null;
  const { site, environments, linked_clients: links } = detail;

  async function toggleReadOnly(envId, current) {
    try {
      await setEnvReadOnly(envId, !current);
      toast(`Environment ${!current ? 'locked' : 'unlocked'}`, 'success');
      onChange?.();
    } catch (err) {
      toast(err.response?.data?.message || 'Toggle failed', 'error');
    }
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="overline">Site</Typography>
        <Typography variant="h5">{site.display_name || site.site_name}</Typography>
        <Typography variant="caption" color="text.secondary">
          Kinsta ID: {site.kinsta_site_id}
        </Typography>
      </Box>
      <Box>
        <Typography variant="overline">Environments</Typography>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {environments.map((e) => (
            <Stack key={e.id} direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
              <StatusChip status={e.is_live ? 'completed' : 'pending'} label={e.environment_name} />
              <Typography variant="body2">{e.primary_domain || '—'}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                {e.ssh_username}@{e.ssh_host}:{e.ssh_port}
              </Typography>
              <StatusChip
                status={e.ssh_password_present ? 'connected' : 'disconnected'}
                label={e.ssh_password_present ? 'creds present' : 'no creds'}
              />
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={Boolean(e.read_only)}
                    onChange={() => toggleReadOnly(e.id, e.read_only)}
                  />
                }
                label={<Typography variant="caption">read-only</Typography>}
                sx={{ ml: 'auto' }}
              />
            </Stack>
          ))}
        </Stack>
      </Box>
      <Box>
        <Typography variant="overline">Linked Clients</Typography>
        <Typography variant="body2">{links?.length ? `${links.length} linked` : 'None'}</Typography>
      </Box>
    </Stack>
  );
}

export default function SiteDrawer({ siteId, open, onClose, initialPanel = 'overview' }) {
  const { showToast: toast } = useToast();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [panel, setPanel] = useState(initialPanel);

  const reload = useCallback(() => {
    if (!siteId) return;
    setLoading(true);
    fetchOperationsSite(siteId)
      .then(setDetail)
      .catch((err) => toast(err.response?.data?.message || 'Failed to load site', 'error'))
      .finally(() => setLoading(false));
  }, [siteId, toast]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  useEffect(() => {
    if (open) setPanel(initialPanel);
  }, [open, initialPanel]);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', md: '70%', lg: '60%' } } }}
    >
      <Stack direction="row" alignItems="center" sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h4" sx={{ flex: 1 }}>
          {detail?.site?.display_name || detail?.site?.site_name || 'Site'}
        </Typography>
        <IconButton onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </Stack>
      <Tabs value={panel} onChange={(_, v) => setPanel(v)} sx={{ px: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        {SUB_TABS.map((t) => (
          <Tab key={t.value} value={t.value} label={t.label} />
        ))}
      </Tabs>
      <Box sx={{ p: 2, flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {loading && !detail && <Typography variant="body2">Loading…</Typography>}
        {detail && panel === 'overview' && <Overview detail={detail} onChange={reload} />}
        {detail && panel === 'findings' && <SiteFindings siteId={siteId} />}
        {detail && panel === 'assistant' && <SiteAssistant siteId={siteId} />}
        {detail && panel === 'terminal' && <SiteTerminal environments={detail.environments} />}
        {detail && panel === 'workspace' && <SiteWorkspaceEditor siteId={siteId} />}
        {detail && panel === 'clients' && (
          <SiteClientLinks siteId={siteId} links={detail.linked_clients} onChange={reload} />
        )}
        {detail && panel === 'history' && <SiteCommandHistory environments={detail.environments} />}
      </Box>
    </Drawer>
  );
}
