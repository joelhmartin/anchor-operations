/**
 * RunDetail — Phase 3 Operations rebuild UI v1.
 *
 * Shows a single ops run with check_results grouped by umbrella + a flat
 * findings list. Click a check_result row to inspect the raw payload_json
 * (a simple <pre> JSON viewer is sufficient for v1).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  IconButton,
  Stack,
  Typography
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import CancelIcon from '@mui/icons-material/Cancel';
import ReplayIcon from '@mui/icons-material/Replay';
import DownloadIcon from '@mui/icons-material/Download';
import SubCard from 'ui-component/cards/SubCard';
import StatusChip from 'ui-component/extended/StatusChip';
import EmptyState from 'ui-component/extended/EmptyState';
import LoadingButton from 'ui-component/extended/LoadingButton';
import { useToast } from 'contexts/ToastContext';
import {
  getOpsRun,
  listOpsCheckResults,
  getOpsRunFindings,
  cancelOpsRun,
  triggerOpsRun,
  getOpsRunReport
} from 'api/ops';

const SEVERITY_COLOR = {
  critical: 'error',
  warning: 'warning',
  info: 'info',
  null: 'default'
};

const STATUS_COLOR = {
  pass: 'success',
  fail: 'error',
  skipped: 'default',
  error: 'warning',
  partial: 'warning',
  completed: 'success',
  running: 'info',
  queued: 'default',
  cancelled: 'default',
  budget_exceeded: 'warning'
};

function severityChipColor(sev) {
  return SEVERITY_COLOR[sev] || 'default';
}

function CheckResultRow({ row }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', py: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <IconButton size="small" onClick={() => setOpen((v) => !v)}>
          <ExpandMoreIcon
            sx={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
          />
        </IconButton>
        <Typography variant="body2" sx={{ flex: 1, fontFamily: 'monospace' }}>
          {row.check_id}
        </Typography>
        <StatusChip label={row.status} color={STATUS_COLOR[row.status] || 'default'} />
        {row.severity && <Chip size="small" label={row.severity} color={severityChipColor(row.severity)} />}
        <Typography variant="caption" color="text.secondary">
          {row.duration_ms ? `${row.duration_ms}ms` : '—'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {row.cost_cents ? `${row.cost_cents}¢` : ''}
        </Typography>
      </Stack>
      <Collapse in={open}>
        <Box
          component="pre"
          sx={{
            bgcolor: 'background.default',
            p: 1.5,
            borderRadius: 1,
            mt: 1,
            mb: 1,
            fontSize: '0.75rem',
            overflowX: 'auto',
            maxHeight: 400
          }}
        >
          {JSON.stringify(row.payload_json || {}, null, 2)}
        </Box>
      </Collapse>
    </Box>
  );
}

export default function RunDetail({ runId, onBack }) {
  const { showToast } = useToast();
  const [run, setRun] = useState(null);
  const [checkResults, setCheckResults] = useState([]);
  const [findings, setFindings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, cr, f] = await Promise.all([
        getOpsRun(runId),
        listOpsCheckResults(runId),
        getOpsRunFindings(runId)
      ]);
      setRun(r);
      setCheckResults(cr);
      setFindings(f);
    } catch (err) {
      showToast(`Failed to load run: ${err.message || 'unknown'}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [runId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRerun = async () => {
    if (!run) return;
    setRerunning(true);
    try {
      const created = await triggerOpsRun({
        client_user_id: run.client_user_id,
        run_definition_id: run.run_definition_id || undefined,
        tier: run.tier,
        trigger: 'manual'
      });
      showToast(`Re-run queued (${created.id?.slice(0, 8)})`, 'success');
    } catch (err) {
      showToast(`Re-run failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setRerunning(false);
    }
  };

  const handleDownloadReport = async () => {
    setReportLoading(true);
    try {
      const report = await getOpsRunReport(runId);
      if (report?.signed_url) {
        window.open(report.signed_url, '_blank', 'noopener');
        showToast('Report opened in new tab', 'success');
      } else {
        showToast('Report exists but no signed URL is available yet', 'warning');
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        showToast('No report generated for this run yet', 'info');
      } else {
        showToast(`Report fetch failed: ${err.response?.data?.message || err.message}`, 'error');
      }
    } finally {
      setReportLoading(false);
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelOpsRun(runId);
      showToast('Run cancellation requested', 'success');
      load();
    } catch (err) {
      showToast(`Cancel failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setCancelling(false);
    }
  };

  const groupedByUmbrella = checkResults.reduce((acc, row) => {
    const key = row.umbrella || 'unknown';
    acc[key] = acc[key] || [];
    acc[key].push(row);
    return acc;
  }, {});

  const cancellable = run && (run.status === 'queued' || run.status === 'running');

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button startIcon={<ArrowBackIcon />} onClick={onBack} size="small">
          Back to runs
        </Button>
        <Box sx={{ flex: 1 }} />
        <LoadingButton
          startIcon={<RefreshIcon />}
          variant="outlined"
          onClick={load}
          loading={loading}
          loadingLabel="Loading"
        >
          Refresh
        </LoadingButton>
        <LoadingButton
          startIcon={<DownloadIcon />}
          variant="outlined"
          onClick={handleDownloadReport}
          loading={reportLoading}
          loadingLabel="Fetching"
        >
          Report
        </LoadingButton>
        <LoadingButton
          startIcon={<ReplayIcon />}
          variant="outlined"
          onClick={handleRerun}
          loading={rerunning}
          loadingLabel="Queueing"
          disabled={!run}
        >
          Re-run
        </LoadingButton>
        {cancellable && (
          <LoadingButton
            startIcon={<CancelIcon />}
            color="warning"
            variant="outlined"
            onClick={handleCancel}
            loading={cancelling}
            loadingLabel="Cancelling"
          >
            Cancel run
          </LoadingButton>
        )}
      </Stack>

      {run && (
        <SubCard title={`Run ${run.id?.slice(0, 8)}`}>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
            <StatusChip label={run.status} color={STATUS_COLOR[run.status] || 'default'} />
            <Typography variant="body2"><strong>Tier:</strong> {run.tier}</Typography>
            <Typography variant="body2">
              <strong>Duration:</strong> {run.duration_ms ? `${run.duration_ms}ms` : '—'}
            </Typography>
            <Typography variant="body2">
              <strong>Cost:</strong> {run.cost_estimate_cents || 0}¢
            </Typography>
            <Typography variant="body2">
              <strong>Trigger:</strong> {run.trigger}
            </Typography>
          </Stack>
        </SubCard>
      )}

      {(() => {
        const correlations = findings.filter((f) => (f.category || '').startsWith('correlation.'));
        const others = findings.filter((f) => !(f.category || '').startsWith('correlation.'));
        return (
          <>
            {correlations.length > 0 && (
              <SubCard
                title={`Cross-platform correlations (${correlations.length})`}
                sx={{ borderLeft: 4, borderColor: 'error.main' }}
              >
                <Stack spacing={1.5}>
                  {correlations.map((f) => (
                    <Box
                      key={f.id}
                      sx={{
                        p: 1.5,
                        borderRadius: 1,
                        bgcolor: 'background.default',
                        border: 1,
                        borderColor: 'divider'
                      }}
                    >
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                        <Chip size="small" label={f.severity} color={severityChipColor(f.severity)} />
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                          {f.category}
                        </Typography>
                      </Stack>
                      <Typography variant="body2">{f.summary}</Typography>
                    </Box>
                  ))}
                </Stack>
              </SubCard>
            )}
            {others.length > 0 && (
              <SubCard title={`Findings (${others.length})`}>
                <Stack spacing={1}>
                  {others.map((f) => (
                    <Stack key={f.id} direction="row" spacing={1} alignItems="center">
                      <Chip size="small" label={f.severity} color={severityChipColor(f.severity)} />
                      <Typography variant="body2" sx={{ flex: 1 }}>
                        {f.summary}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {f.category}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </SubCard>
            )}
          </>
        );
      })()}

      <SubCard title="Check results">
        {checkResults.length === 0 ? (
          <EmptyState
            title="No check results yet"
            message={
              run?.status === 'queued' || run?.status === 'running'
                ? 'Run is in flight; refresh in a moment.'
                : 'This run did not produce any check results.'
            }
          />
        ) : (
          Object.entries(groupedByUmbrella).map(([umbrella, rows]) => (
            <Box key={umbrella} sx={{ mb: 2 }}>
              <Typography variant="overline" color="text.secondary">
                {umbrella}
              </Typography>
              <Divider sx={{ mb: 1 }} />
              {rows.map((row) => (
                <CheckResultRow key={row.id} row={row} />
              ))}
            </Box>
          ))
        )}
      </SubCard>

      {!loading && !run && <Alert severity="error">Run not found</Alert>}
    </Stack>
  );
}
