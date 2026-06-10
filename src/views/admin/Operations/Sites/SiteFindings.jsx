import { useCallback, useEffect, useState } from 'react';
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import LoadingButton from 'ui-component/extended/LoadingButton';
import EmptyState from 'ui-component/extended/EmptyState';
import { useToast } from 'contexts/ToastContext';
import {
  acknowledgeFinding,
  fetchSiteFindings,
  resolveFinding,
  runDriftCheck
} from 'api/operations';

const SEVERITY_COLOR = {
  critical: 'error',
  warning: 'warning',
  info: 'info'
};

export default function SiteFindings({ siteId }) {
  const { showToast: toast } = useToast();
  const [findings, setFindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setFindings(await fetchSiteFindings(siteId, { open: 1 }));
    } catch (err) {
      toast(err.response?.data?.message || 'Failed to load findings', 'error');
    } finally {
      setLoading(false);
    }
  }, [siteId, toast]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function runCheck() {
    setRunning(true);
    try {
      const result = await runDriftCheck(siteId, { include_tracking: true });
      toast(
        result.findings.length
          ? `Drift check found ${result.findings.length} issue(s)`
          : 'No drift detected',
        result.findings.length ? 'warning' : 'success'
      );
      reload();
    } catch (err) {
      toast(err.response?.data?.message || 'Drift check failed', 'error');
    } finally {
      setRunning(false);
    }
  }

  async function ack(findingId) {
    try {
      await acknowledgeFinding(findingId);
      reload();
    } catch (err) {
      toast(err.response?.data?.message || 'Acknowledge failed', 'error');
    }
  }
  async function resolve(findingId) {
    try {
      await resolveFinding(findingId);
      toast('Finding resolved', 'success');
      reload();
    } catch (err) {
      toast(err.response?.data?.message || 'Resolve failed', 'error');
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          Open findings ({findings.length})
        </Typography>
        <LoadingButton
          variant="outlined"
          onClick={runCheck}
          loading={running}
          loadingLabel="Checking…"
        >
          Run drift check
        </LoadingButton>
      </Stack>

      {!loading && findings.length === 0 && (
        <EmptyState
          title="No open findings."
          message="Click 'Run drift check' to compare current site state against the saved baseline."
        />
      )}

      <Stack spacing={1}>
        {findings.map((f) => (
          <Box
            key={f.id}
            sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
          >
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Chip
                size="small"
                color={SEVERITY_COLOR[f.severity] || 'default'}
                label={f.severity}
              />
              <Chip size="small" variant="outlined" label={f.category} />
              <Typography variant="body2" sx={{ flex: 1 }}>
                {f.summary}
              </Typography>
              {!f.acknowledged_at && (
                <Tooltip title="Acknowledge">
                  <IconButton size="small" onClick={() => ack(f.id)}>
                    <VisibilityOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title="Mark resolved">
                <IconButton size="small" onClick={() => resolve(f.id)}>
                  <CheckCircleOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              {new Date(f.created_at).toLocaleString()}
              {f.acknowledged_at ? ' · acknowledged' : ''}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}
