/**
 * CommandCenterTab — Operations command center inbox.
 *
 * Phase A shipped a placeholder over `/api/ops/findings` sorted by severity.
 * Phase C swaps in the dedicated `/api/ops/command-center` aggregate (KPI
 * strip + ranked attention-score inbox + activity feed).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Chip, Grid, Stack, TextField, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ShieldIcon from '@mui/icons-material/Shield';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import MainCard from 'ui-component/cards/MainCard';
import StatusChip from 'ui-component/extended/StatusChip';
import EmptyState from 'ui-component/extended/EmptyState';
import LoadingButton from 'ui-component/extended/LoadingButton';
import ConfirmDialog from 'ui-component/extended/ConfirmDialog';
import FormDialog from 'ui-component/extended/FormDialog';
import { useToast } from 'contexts/ToastContext';
import { Button } from '@mui/material';
import { getCommandCenter, ignoreOpsFinding, assignOpsFinding, listOpsClients } from 'api/ops';
import { clientLabel } from '../_clientLabel';

const POLL_MS = 60000;

function severityColor(sev) {
  return { critical: 'error', warning: 'warning', info: 'info' }[sev] || 'default';
}

function fmt(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

function KpiCard({ label, value, hint, onClick }) {
  return (
    <MainCard
      content
      sx={{
        cursor: onClick ? 'pointer' : 'default',
        '&:hover': onClick ? { boxShadow: 4 } : undefined
      }}
      onClick={onClick}
    >
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h3" sx={{ mt: 0.5 }}>
        {value}
      </Typography>
      {hint ? (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      ) : null}
    </MainCard>
  );
}

export default function CommandCenterTab({ onOpenDiscovery, onOpenRun, onOpenDiscoveriesFiltered }) {
  const { showToast } = useToast();
  const [data, setData] = useState({ discoveries: [], kpis: {}, activity: [] });
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ignoreTarget, setIgnoreTarget] = useState(null);
  const [ignoreReason, setIgnoreReason] = useState('');
  const [ignoreSubmitting, setIgnoreSubmitting] = useState(false);
  const [assignTarget, setAssignTarget] = useState(null);
  const [assignUserId, setAssignUserId] = useState('');
  const [assignSubmitting, setAssignSubmitting] = useState(false);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) setLoading(true);
      try {
        const result = await getCommandCenter();
        setData(result || { discoveries: [], kpis: {}, activity: [] });
      } catch (err) {
        if (!silent) {
          showToast(`Couldn't load Command Center: ${err.response?.data?.message || err.message}`, 'error');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    load();
    const t = setInterval(() => load({ silent: true }), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    listOpsClients()
      .then(setClients)
      .catch(() => setClients([]));
  }, []);

  const clientNameById = useMemo(() => {
    const m = new Map();
    for (const c of clients) m.set(c.id, clientLabel(c));
    return m;
  }, [clients]);

  const submitIgnore = async () => {
    if (!ignoreTarget) return;
    if (!ignoreReason.trim()) {
      showToast('A reason is required to ignore a discovery', 'warning');
      return;
    }
    setIgnoreSubmitting(true);
    try {
      // Ignored rows leave the open/investigating set, so drop the row from
      // the local inbox immediately rather than waiting for a refetch.
      await ignoreOpsFinding(ignoreTarget.id, ignoreReason.trim());
      const ignoredId = ignoreTarget.id;
      setData((prev) => ({
        ...prev,
        discoveries: (prev.discoveries || []).filter((d) => d.id !== ignoredId),
        kpis: prev.kpis || {}
      }));
      showToast('Discovery ignored', 'success');
      setIgnoreTarget(null);
      setIgnoreReason('');
    } catch (err) {
      showToast(`Ignore failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setIgnoreSubmitting(false);
    }
  };

  const submitAssign = async () => {
    if (!assignTarget || !assignUserId.trim()) return;
    setAssignSubmitting(true);
    try {
      const updated = await assignOpsFinding(assignTarget.id, assignUserId.trim());
      setData((prev) => ({
        ...prev,
        discoveries: (prev.discoveries || []).map((d) => (d.id === assignTarget.id ? { ...d, ...(updated || {}) } : d)),
        kpis: prev.kpis || {}
      }));
      showToast('Discovery assigned', 'success');
      setAssignTarget(null);
      setAssignUserId('');
    } catch (err) {
      showToast(`Assign failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setAssignSubmitting(false);
    }
  };

  const kpis = data.kpis || {};

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h4">Command Center</Typography>
        <Box sx={{ flex: 1 }} />
        <LoadingButton
          startIcon={<RefreshIcon />}
          onClick={() => load()}
          loading={loading}
          loadingLabel="Loading"
          variant="outlined"
          size="small"
        >
          Refresh
        </LoadingButton>
      </Stack>

      <Grid container spacing={2}>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard
            label="Clients at risk"
            value={kpis.clients_at_risk ?? 0}
            hint="critical · open or investigating"
            onClick={() => onOpenDiscoveriesFiltered?.({ severity: 'critical', status: null })}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard label="Approvals waiting" value={kpis.approvals_waiting ?? 0} hint="agent-proposed actions" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard label="Discoveries · 24h" value={kpis.changes_24h ?? 0} hint="new in last 24h" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard label="Stuck runs" value={kpis.automation_stuck ?? 0} hint="running > 1h" />
        </Grid>
      </Grid>

      <MainCard title="Inbox" content={false}>
        {loading && data.discoveries.length === 0 ? (
          <Box sx={{ p: 3 }}>
            <Typography variant="body2" color="text.secondary">
              Loading…
            </Typography>
          </Box>
        ) : data.discoveries.length === 0 ? (
          <Box sx={{ p: 3 }}>
            <EmptyState
              title="Inbox clear"
              message="No open or investigating discoveries. Trigger a run, or relax filters to see ignored / resolved ones in the Discoveries tab."
            />
          </Box>
        ) : (
          <Stack divider={<Box sx={{ borderBottom: 1, borderColor: 'divider' }} />}>
            {data.discoveries.map((d) => {
              const clientName = clientNameById.get(d.client_user_id) || shortId(d.client_user_id) || '—';
              return (
                <Box key={d.id} sx={{ p: 2 }}>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }}>
                    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                        <Chip size="small" label={d.severity || 'info'} color={severityColor(d.severity)} />
                        <StatusChip status={d.status === 'investigating' ? 'in_progress' : 'pending'} label={d.status || 'open'} />
                        <Typography variant="body2" color="text.secondary">
                          {clientName}
                        </Typography>
                        {Array.isArray(d.affected_platforms) && d.affected_platforms.length > 0 && (
                          <>
                            {d.affected_platforms.map((p) => (
                              <Chip key={p} size="small" variant="outlined" label={p} />
                            ))}
                          </>
                        )}
                        <Typography variant="caption" color="text.secondary">
                          score {Number(d.attention_score || 0).toFixed(1)} · {fmt(d.created_at)}
                        </Typography>
                      </Stack>
                      <Typography variant="body1" sx={{ fontWeight: 500 }}>
                        {d.summary || d.category}
                      </Typography>
                      {d.business_impact ? (
                        <Typography variant="body2" color="text.secondary">
                          {d.business_impact}
                        </Typography>
                      ) : null}
                    </Stack>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap">
                      <Button size="small" variant="outlined" startIcon={<OpenInNewIcon />} onClick={() => onOpenDiscovery?.(d.id)}>
                        Investigate
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<AutoAwesomeIcon />}
                        disabled
                        title="Generate Plan ships in Phase D"
                      >
                        Generate Plan
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<ShieldIcon />}
                        disabled={!d.proposed_plan_json}
                        title={d.proposed_plan_json ? 'Approve fix' : 'Generate a plan first'}
                      >
                        Approve fix
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<PersonAddIcon />}
                        onClick={() => {
                          setAssignTarget(d);
                          setAssignUserId(d.owner_user_id || '');
                        }}
                      >
                        Assign
                      </Button>
                      <Button
                        size="small"
                        color="warning"
                        variant="outlined"
                        startIcon={<VisibilityOffIcon />}
                        onClick={() => {
                          setIgnoreTarget(d);
                          setIgnoreReason('');
                        }}
                      >
                        Ignore
                      </Button>
                    </Stack>
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        )}
      </MainCard>

      <MainCard title="Recent activity">
        {Array.isArray(data.activity) && data.activity.length > 0 ? (
          <Stack spacing={0.5}>
            {data.activity.map((a, idx) => (
              <Stack key={idx} direction="row" spacing={1} alignItems="center">
                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 160 }}>
                  {fmt(a.created_at)}
                </Typography>
                <Chip size="small" variant="outlined" label={a.event_type || a.eventType} />
                <Typography variant="caption" color="text.secondary">
                  {a.success === false ? 'failed' : 'ok'}
                </Typography>
              </Stack>
            ))}
          </Stack>
        ) : (
          <EmptyState title="No recent activity" message="Status changes, approvals, and executions land here." />
        )}
      </MainCard>

      <ConfirmDialog
        open={Boolean(ignoreTarget)}
        onClose={() => setIgnoreTarget(null)}
        onConfirm={submitIgnore}
        title="Ignore this discovery?"
        message="It will be hidden from the Command Center inbox and stay queryable in Discoveries with status=ignored."
        confirmLabel="Ignore"
        confirmColor="warning"
        loading={ignoreSubmitting}
        loadingLabel="Ignoring"
      >
        <Box sx={{ mt: 1 }}>
          <TextField
            label="Reason"
            value={ignoreReason}
            onChange={(e) => setIgnoreReason(e.target.value)}
            multiline
            minRows={2}
            fullWidth
            size="small"
            required
          />
        </Box>
      </ConfirmDialog>

      <FormDialog
        open={Boolean(assignTarget)}
        onClose={() => setAssignTarget(null)}
        onSubmit={submitAssign}
        title="Assign discovery"
        loading={assignSubmitting}
        submitLabel="Assign"
        submitDisabled={!assignUserId.trim()}
      >
        <TextField
          label="Owner user id (UUID)"
          value={assignUserId}
          onChange={(e) => setAssignUserId(e.target.value)}
          fullWidth
          size="small"
          autoFocus
        />
      </FormDialog>
    </Stack>
  );
}
