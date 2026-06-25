import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  Stack,
  TextField,
  Typography,
  Autocomplete
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { fetchClientSites, fetchOperationsSites, linkSiteToClient, unlinkSiteClient } from 'api/operations';
import { useToast } from 'contexts/ToastContext';
import EmptyState from 'ui-component/extended/EmptyState';
import LoadingButton from 'ui-component/extended/LoadingButton';
import SiteDrawer from '../Sites/SiteDrawer';

// fetchClientSites returns plain array; each row: { link_id, site_id, site_name, display_name, primary_domain, relationship, ... }
// fetchOperationsSites returns plain array; each row: { id, site_name, display_name, ... }

export default function ClientSitesPanel({ clientUserId }) {
  const { showToast } = useToast();
  const [sites, setSites] = useState([]);
  const [allSites, setAllSites] = useState([]);
  const [picked, setPicked] = useState(null);
  const [linking, setLinking] = useState(false);
  const [openSiteId, setOpenSiteId] = useState(null);

  const reload = useCallback(() => {
    fetchClientSites(clientUserId)
      .then((r) => setSites(r || []))
      .catch(() => setSites([]));
  }, [clientUserId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    fetchOperationsSites()
      .then((r) => setAllSites(r || []))
      .catch(() => setAllSites([]));
  }, []);

  const assign = async () => {
    if (!picked) return;
    setLinking(true);
    try {
      await linkSiteToClient(picked.id, { client_user_id: clientUserId, relationship: 'primary' });
      showToast('Site assigned to client', 'success');
      setPicked(null);
      reload();
    } catch (err) {
      showToast(err?.response?.data?.message || 'Failed to assign site', 'error');
    } finally {
      setLinking(false);
    }
  };

  const unassign = async (site) => {
    // client-site rows use site_id (site UUID) and link_id (the join-table row UUID)
    try {
      await unlinkSiteClient(site.site_id, site.link_id);
      setSites((prev) => prev.filter((s) => s.link_id !== site.link_id));
      showToast('Site unlinked', 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Failed to unlink', 'error');
      reload();
    }
  };

  // all-sites rows use `id`; client-sites rows use `site_id`
  const available = allSites.filter((s) => !sites.some((cs) => cs.site_id === s.id));

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }} alignItems="center">
        <Autocomplete
          size="small"
          sx={{ minWidth: 320 }}
          options={available}
          value={picked}
          onChange={(_, v) => setPicked(v)}
          getOptionLabel={(s) => s.display_name || s.site_name || s.kinsta_site_id || ''}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          renderInput={(p) => <TextField {...p} label="Assign a Kinsta site" />}
        />
        <LoadingButton
          variant="contained"
          loading={linking}
          loadingLabel="Assigning…"
          disabled={!picked}
          onClick={assign}
        >
          Assign
        </LoadingButton>
      </Stack>

      {sites.length === 0 ? (
        <EmptyState title="No sites linked" message="Assign a Kinsta site to this client to manage it here." />
      ) : (
        <Stack spacing={1.5}>
          {sites.map((s) => (
            <Card key={s.link_id} variant="outlined">
              <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle1" noWrap>
                    {s.display_name || s.site_name}
                  </Typography>
                  {s.primary_domain && (
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {s.primary_domain}
                    </Typography>
                  )}
                </Box>
                {s.relationship && <Chip size="small" label={s.relationship} />}
                <Button size="small" startIcon={<OpenInNewIcon />} onClick={() => setOpenSiteId(s.site_id)}>
                  Open
                </Button>
                <IconButton size="small" onClick={() => unassign(s)} aria-label="unlink">
                  <LinkOffIcon fontSize="small" />
                </IconButton>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      <SiteDrawer siteId={openSiteId} open={Boolean(openSiteId)} onClose={() => setOpenSiteId(null)} />
    </Box>
  );
}
