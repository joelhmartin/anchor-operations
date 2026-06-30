/**
 * ClientConnectionsPanel — V3 per-client Service Connections.
 *
 * One card per platform showing the REAL connection status (derived from the
 * client's own config + join tables, overlaid with the latest live verify),
 * plus a Verify button that runs a read-only live check and updates the card.
 */

import { useCallback, useEffect, useState } from 'react';
import { Box, Grid, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import VerifiedIcon from '@mui/icons-material/Verified';
import MainCard from 'ui-component/cards/MainCard';
import SubCard from 'ui-component/cards/SubCard';
import StatusChip from 'ui-component/extended/StatusChip';
import LoadingButton from 'ui-component/extended/LoadingButton';
import EmptyState from 'ui-component/extended/EmptyState';
import { useToast } from 'contexts/ToastContext';
import { listClientConnections, verifyClientConnection } from 'api/ops';

const PROVIDER_LABELS = {
  google_ads: 'Google Ads',
  ga4: 'Google Analytics 4',
  meta: 'Meta (Facebook)',
  website: 'Website',
  ctm: 'CallTrackingMetrics',
  kinsta: 'Kinsta Hosting'
};

// UI status → StatusChip status (color). connected=green, partial=yellow, not_provided=gray.
const STATUS_CHIP = {
  connected: { status: 'connected', label: 'Connected' },
  partial: { status: 'pending', label: 'Partial' },
  not_provided: { status: 'inactive', label: 'Not provided' }
};

function fmt(ts) {
  if (!ts) return 'never';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function ClientConnectionsPanel({ clientUserId }) {
  const { showToast } = useToast();
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [verifyingProvider, setVerifyingProvider] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listClientConnections(clientUserId);
      setConnections(data);
    } catch (err) {
      showToast(`Couldn't load connections: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [clientUserId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const verify = async (provider) => {
    setVerifyingProvider(provider);
    try {
      const result = await verifyClientConnection(clientUserId, provider);
      setConnections((prev) =>
        prev.map((c) =>
          c.provider === provider
            ? { ...c, status: result.status, detail: result.detail, lastVerifiedAt: result.lastVerifiedAt }
            : c
        )
      );
      showToast(`${PROVIDER_LABELS[provider] || provider}: ${result.status}`, result.status === 'connected' ? 'success' : 'info');
    } catch (err) {
      showToast(`Verify failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setVerifyingProvider(null);
    }
  };

  return (
    <MainCard
      title="Service Connections"
      secondary={
        <LoadingButton
          startIcon={<RefreshIcon />}
          variant="outlined"
          size="small"
          onClick={load}
          loading={loading}
          loadingLabel="Loading"
        >
          Refresh
        </LoadingButton>
      }
    >
      {connections.length === 0 ? (
        <EmptyState title="No platforms" message="No service connections to show for this client." />
      ) : (
        <Grid container spacing={2}>
          {connections.map((c) => {
            const chip = STATUS_CHIP[c.status] || STATUS_CHIP.not_provided;
            return (
              <Grid item xs={12} md={6} key={c.provider}>
                <SubCard title={PROVIDER_LABELS[c.provider] || c.provider}>
                  <Stack spacing={1.5}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <StatusChip status={chip.status} label={chip.label} />
                      {c.accountRef ? (
                        <Typography variant="caption" sx={{ fontFamily: 'monospace' }} color="text.secondary">
                          {c.accountRef}
                        </Typography>
                      ) : null}
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      {c.detail || '—'}
                    </Typography>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="caption" color="text.secondary">
                        Last verified: {fmt(c.lastVerifiedAt)}
                      </Typography>
                      <Box sx={{ flex: 1 }} />
                      <LoadingButton
                        size="small"
                        variant="outlined"
                        startIcon={<VerifiedIcon />}
                        onClick={() => verify(c.provider)}
                        loading={verifyingProvider === c.provider}
                        loadingLabel="Verifying"
                      >
                        Verify
                      </LoadingButton>
                    </Stack>
                  </Stack>
                </SubCard>
              </Grid>
            );
          })}
        </Grid>
      )}
    </MainCard>
  );
}
