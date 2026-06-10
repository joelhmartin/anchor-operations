import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, Chip, Stack, Typography } from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import LoadingButton from 'ui-component/extended/LoadingButton';
import DataTable from 'ui-component/extended/DataTable';
import StatusChip from 'ui-component/extended/StatusChip';
import { useToast } from 'contexts/ToastContext';
import { fetchFindingCounts, fetchOperationsSites, syncOperationsSites } from 'api/operations';
import SiteDrawer from './SiteDrawer';

function relativeAge(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default function SitesTab() {
  const { showToast: toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [drawer, setDrawer] = useState({ open: false, siteId: null, panel: 'overview' });

  // Open drawer from URL query (?site=<id>&panel=<sub-tab>) on mount/change.
  useEffect(() => {
    const siteId = searchParams.get('site');
    const panel = searchParams.get('panel') || 'overview';
    if (siteId && (!drawer.open || drawer.siteId !== siteId)) {
      setDrawer({ open: true, siteId, panel });
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([fetchOperationsSites(), fetchFindingCounts().catch(() => [])])
      .then(([siteRows, countRows]) => {
        const counts = new Map(countRows.map((c) => [c.site_id, c]));
        setSites(
          siteRows.map((s) => ({
            ...s,
            open_finding_count: counts.get(s.id)?.open_count || 0,
            critical_finding_count: counts.get(s.id)?.critical_count || 0
          }))
        );
      })
      .catch((err) => toast(err.response?.data?.message || 'Failed to load sites', 'error'))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await syncOperationsSites();
      toast(`Synced ${res.sites} sites / ${res.environments} envs`, 'success');
      reload();
    } catch (err) {
      toast(err.response?.data?.message || 'Sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  }

  function openDrawer(siteId, panel = 'overview') {
    setDrawer({ open: true, siteId, panel });
  }

  const columns = useMemo(
    () => [
      {
        id: 'site_name',
        label: 'Site',
        sortable: true,
        render: (r) => (
          <Stack>
            <Typography variant="body2" fontWeight={600}>
              {r.display_name || r.site_name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {r.primary_domain || r.kinsta_site_id}
            </Typography>
          </Stack>
        )
      },
      {
        id: 'environment_count',
        label: 'Envs',
        render: (r) => <Chip size="small" label={r.environment_count} />
      },
      {
        id: 'last_scan_at',
        label: 'Last scan',
        render: (r) => relativeAge(r.last_scan_at)
      },
      {
        id: 'linked_client_count',
        label: 'Clients',
        render: (r) =>
          r.linked_client_count > 0 ? (
            <StatusChip status="connected" label={String(r.linked_client_count)} />
          ) : (
            <StatusChip status="inactive" label="0" />
          )
      },
      {
        id: 'open_finding_count',
        label: 'Findings',
        render: (r) => {
          if (!r.open_finding_count) return <Typography variant="caption">—</Typography>;
          return (
            <Chip
              size="small"
              color={r.critical_finding_count > 0 ? 'error' : 'warning'}
              label={`${r.open_finding_count} open`}
              onClick={(e) => {
                e.stopPropagation();
                openDrawer(r.id, 'findings');
              }}
            />
          );
        }
      },
      {
        id: 'actions',
        label: '',
        render: (r) => (
          <Stack direction="row" spacing={0.5}>
            <LoadingButton
              size="small"
              variant="outlined"
              startIcon={<TerminalIcon />}
              onClick={(e) => {
                e.stopPropagation();
                openDrawer(r.id, 'terminal');
              }}
            >
              Terminal
            </LoadingButton>
            <LoadingButton
              size="small"
              variant="text"
              startIcon={<OpenInFullIcon />}
              onClick={(e) => {
                e.stopPropagation();
                openDrawer(r.id, 'overview');
              }}
            >
              Open
            </LoadingButton>
          </Stack>
        )
      }
    ],
    []
  );

  return (
    <Box>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h4" sx={{ flex: 1 }}>
          Kinsta Sites
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {sites.length} sites
        </Typography>
        <LoadingButton variant="outlined" loading={syncing} loadingLabel="Syncing…" onClick={handleSync}>
          Sync from Kinsta
        </LoadingButton>
      </Stack>
      <DataTable
        columns={columns}
        rows={sites}
        rowKey="id"
        loading={loading}
        searchable
        searchFields={['site_name', 'display_name', 'primary_domain']}
        paginated
        pageSize={25}
        emptyTitle="No sites yet."
        emptyMessage="Click 'Sync from Kinsta' to import sites."
        onRowClick={(row) => openDrawer(row.id, 'overview')}
      />
      <SiteDrawer
        open={drawer.open}
        siteId={drawer.siteId}
        initialPanel={drawer.panel}
        onClose={() => {
          setDrawer({ open: false, siteId: null, panel: 'overview' });
          if (searchParams.get('site')) {
            const next = new URLSearchParams(searchParams);
            next.delete('site');
            next.delete('panel');
            setSearchParams(next, { replace: true });
          }
        }}
      />
    </Box>
  );
}
