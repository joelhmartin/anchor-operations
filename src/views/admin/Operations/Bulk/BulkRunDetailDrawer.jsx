import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Drawer,
  Box,
  Stack,
  Typography,
  IconButton,
  Divider,
  Alert,
  Skeleton,
  Chip,
  Collapse,
  CircularProgress,
  Tooltip
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import DataTable from 'ui-component/extended/DataTable';
import StatusChip from 'ui-component/extended/StatusChip';
import { useToast } from 'contexts/ToastContext';
import { getErrorMessage } from 'utils/errors';
import { getBulkRun, getRunFindings } from 'api/opsBulk';

const TERMINAL_STATUSES = new Set(['complete', 'partial', 'failed', 'cancelled']);
const POLL_INTERVAL_MS = 5000;

const SEVERITY_COLORS = {
  critical: 'error',
  high: 'error',
  warning: 'warning',
  medium: 'warning',
  low: 'default',
  info: 'info'
};

function isErrorFinding(f) {
  const category = String(f?.category || '');
  const summary = String(f?.summary || '');
  return category.includes('error') || summary.toLowerCase().startsWith('skill run failed');
}

function fmtMoney(cents) {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDuration(start, end) {
  if (!start) return '—';
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((b - a) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function FindingsPanel({ runId }) {
  const { showToast } = useToast();
  const [findings, setFindings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setLoading(true);
    setFindings(null);
    setExpandedIdx(null);
    getRunFindings(runId)
      .then((rows) => {
        if (!cancelled) setFindings(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          showToast({ type: 'error', message: `Failed to load findings: ${getErrorMessage(e)}` });
          setFindings([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, showToast]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (!findings) return null;

  const errorFindings = findings.filter(isErrorFinding);
  const standardFindings = findings.filter((f) => !isErrorFinding(f));

  if (findings.length === 0) {
    return (
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          No findings for this run.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ px: 2, pb: 2 }}>
      {errorFindings.length > 0 && (
        <Alert severity="error" sx={{ mb: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            Errors ({errorFindings.length})
          </Typography>
          <Stack spacing={0.75}>
            {errorFindings.map((f, idx) => (
              <Typography key={f.id || idx} variant="body2">
                {f.summary || f.title || '(no summary)'}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Findings ({standardFindings.length})
      </Typography>
      <Stack spacing={1}>
        {standardFindings.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No standard findings for this run.
          </Typography>
        ) : (
          standardFindings.map((f, idx) => (
            <Box
              key={f.id || idx}
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                overflow: 'hidden'
              }}
            >
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ px: 1.5, py: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
              >
                <Chip size="small" label={f.severity || 'info'} color={SEVERITY_COLORS[f.severity] || 'default'} />
                {f.category && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                    {f.category}
                  </Typography>
                )}
                <Typography variant="body2" sx={{ flex: 1 }}>
                  {f.summary || f.title || '(no summary)'}
                </Typography>
                {expandedIdx === idx ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
              </Stack>
              <Collapse in={expandedIdx === idx}>
                {f.evidence_json != null && (
                  <Box
                    component="pre"
                    sx={{
                      m: 0,
                      px: 1.5,
                      py: 1,
                      bgcolor: 'grey.50',
                      fontSize: 12,
                      fontFamily: 'monospace',
                      overflowX: 'auto',
                      borderTop: '1px solid',
                      borderColor: 'divider',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all'
                    }}
                  >
                    {typeof f.evidence_json === 'string' ? f.evidence_json : JSON.stringify(f.evidence_json, null, 2)}
                  </Box>
                )}
              </Collapse>
            </Box>
          ))
        )}
      </Stack>
    </Box>
  );
}

export default function BulkRunDetailDrawer({ runId, open, onClose }) {
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedChildId, setExpandedChildId] = useState(null);
  const intervalRef = useRef(null);

  const fetchData = useCallback(
    async ({ silent = false } = {}) => {
      if (!runId) return;
      if (!silent) setLoading(true);
      else setRefreshing(true);
      try {
        const res = await getBulkRun(runId);
        setData(res);
        return res;
      } catch (e) {
        if (!silent) showToast({ type: 'error', message: `Failed to load: ${getErrorMessage(e)}` });
      } finally {
        if (!silent) setLoading(false);
        else setRefreshing(false);
      }
    },
    [runId, showToast]
  );

  // Initial load
  useEffect(() => {
    if (!runId || !open) return;
    setData(null);
    setExpandedChildId(null);
    fetchData();
  }, [runId, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh polling while run is active
  useEffect(() => {
    if (!open || !runId) return;
    const currentStatus = data?.run?.status;
    if (currentStatus && TERMINAL_STATUSES.has(currentStatus)) return;

    intervalRef.current = setInterval(() => {
      fetchData({ silent: true }).then((res) => {
        const newStatus = res?.run?.status;
        if (newStatus && TERMINAL_STATUSES.has(newStatus)) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      });
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [open, runId, data?.run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleManualRefresh = useCallback(() => {
    fetchData({ silent: true });
  }, [fetchData]);

  const skipped = data?.run?.metadata?.skipped || [];
  const failedChildren = (data?.children || []).filter((child) => ['failed', 'cancelled'].includes(child.status));

  const childColumns = [
    {
      id: 'client_name',
      label: 'Client',
      render: (c) => c.client_name || c.client_email || (c.client_user_id ? c.client_user_id.slice(0, 8) : '—')
    },
    {
      id: 'status',
      label: 'Status',
      render: (c) => <StatusChip status={c.status} />
    },
    {
      id: 'findings_count',
      label: 'Findings',
      render: (c) => c.findings_count ?? 0,
      align: 'right'
    },
    {
      id: 'cost_cents',
      label: 'Cost',
      render: (c) => fmtMoney(c.cost_cents),
      align: 'right'
    },
    {
      id: 'duration',
      label: 'Duration',
      render: (c) => fmtDuration(c.started_at, c.finished_at)
    }
  ];

  return (
    <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', md: 760 } } }}>
      <Box sx={{ p: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h5">Bulk run detail</Typography>
          <Stack direction="row" spacing={0.5} alignItems="center">
            {refreshing && <CircularProgress size={16} />}
            <Tooltip title="Refresh">
              <span>
                <IconButton onClick={handleManualRefresh} disabled={refreshing || loading} size="small">
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <IconButton onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </Stack>
        </Stack>

        {loading && (
          <Stack spacing={1}>
            <Skeleton variant="rectangular" height={48} />
            <Skeleton variant="rectangular" height={120} />
            <Skeleton variant="rectangular" height={300} />
          </Stack>
        )}

        {!loading && data?.run && (
          <>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                {data.run.schedule_name || (data.run.trigger === 'manual' ? 'Manual run' : '—')}
              </Typography>
              <StatusChip status={data.run.status} />
            </Stack>

            <Stack direction="row" spacing={3} sx={{ mb: 2, flexWrap: 'wrap' }}>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Clients
                </Typography>
                <Typography variant="body1">{data.run.client_count ?? 0}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Skipped
                </Typography>
                <Typography variant="body1">{data.run.skipped_count ?? 0}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Findings
                </Typography>
                <Typography variant="body1">{data.run.findings_count ?? 0}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Cost
                </Typography>
                <Typography variant="body1">{fmtMoney(data.run.cost_cents)}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Duration
                </Typography>
                <Typography variant="body1">{fmtDuration(data.run.started_at, data.run.completed_at)}</Typography>
              </Box>
            </Stack>

            {skipped.length > 0 && (
              <Alert severity="info" sx={{ mb: 2 }}>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  Skipped {skipped.length} (client × skill) pair{skipped.length === 1 ? '' : 's'}:
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {skipped.slice(0, 12).map((s, i) => (
                    <Chip
                      key={`${s.client_user_id}-${s.skill_slug}-${i}`}
                      size="small"
                      label={`${s.client_name || '(client)'} · ${s.skill_slug} — ${s.reason}`}
                    />
                  ))}
                  {skipped.length > 12 && <Chip size="small" label={`+${skipped.length - 12} more`} />}
                </Stack>
              </Alert>
            )}

            {failedChildren.length > 0 && (
              <Alert severity="error" sx={{ mb: 2 }}>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  {failedChildren.length} client run{failedChildren.length === 1 ? '' : 's'} ended with an error:
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {failedChildren.map((child) => (
                    <Chip
                      key={child.id}
                      size="small"
                      color="error"
                      label={`${child.client_name || child.client_email || child.client_user_id?.slice(0, 8)} — ${child.status}`}
                      onClick={() => setExpandedChildId(child.id)}
                    />
                  ))}
                </Stack>
              </Alert>
            )}

            <Divider sx={{ my: 2 }} />

            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Per-client runs{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                — click a row to view findings
              </Typography>
            </Typography>
            <DataTable
              columns={childColumns}
              rows={data.children || []}
              rowKey="id"
              paginated
              pageSize={20}
              emptyTitle="No child runs"
              emptyMessage="No child runs were enqueued for this bulk run."
              onRowClick={(row) => setExpandedChildId((prev) => (prev === row.id ? null : row.id))}
            />

            {/* Inline findings viewer for the selected child run */}
            {expandedChildId && (
              <Box
                sx={{
                  mt: 2,
                  border: '1px solid',
                  borderColor: 'primary.light',
                  borderRadius: 1,
                  bgcolor: 'background.paper'
                }}
              >
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  sx={{ px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}
                >
                  <Typography variant="subtitle2">
                    {(() => {
                      const child = (data.children || []).find((c) => c.id === expandedChildId);
                      return `Findings — ${child?.client_name || child?.client_email || expandedChildId.slice(0, 8)}`;
                    })()}
                  </Typography>
                  <IconButton size="small" onClick={() => setExpandedChildId(null)}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Stack>
                <FindingsPanel runId={expandedChildId} />
              </Box>
            )}
          </>
        )}
      </Box>
    </Drawer>
  );
}
