/**
 * RunsTab — Phase 3 Operations rebuild UI v1.
 *
 * Lists `ops_runs` rows with client filter, status/tier columns, and a click
 * through to RunDetail. Manual run trigger uses POST /api/ops/runs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Autocomplete, Box, Button, Stack, TextField, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DataTable from 'ui-component/extended/DataTable';
import StatusChip from 'ui-component/extended/StatusChip';
import LoadingButton from 'ui-component/extended/LoadingButton';
import FormDialog from 'ui-component/extended/FormDialog';
import SelectField from 'ui-component/extended/SelectField';

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'partial', label: 'Partial' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'budget_exceeded', label: 'Budget exceeded' }
];

const TIER_FILTER_OPTIONS = [
  { value: '', label: 'Any tier' },
  { value: 'daily_essential', label: 'Daily essential' },
  { value: 'weekly_deep', label: 'Weekly deep' },
  { value: 'monthly_audit', label: 'Monthly audit' }
];
import { useToast } from 'contexts/ToastContext';
import { listOpsRuns, triggerOpsRun, listOpsRunDefinitions, listOpsClients } from 'api/ops';
import { clientLabel } from '../_clientLabel';
import RunDetail from './RunDetail';

const STATUS_PALETTE = {
  queued: 'default',
  running: 'info',
  completed: 'success',
  partial: 'warning',
  failed: 'error',
  cancelled: 'default',
  budget_exceeded: 'warning'
};

function formatDuration(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTimestamp(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default function RunsTab({ runIdToOpen, onRunOpened, onCloseRun } = {}) {
  const { showToast } = useToast();
  const [runs, setRuns] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [clients, setClients] = useState([]);
  const [clientFilter, setClientFilter] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [triggerClient, setTriggerClient] = useState(null);
  const [triggerDef, setTriggerDef] = useState('');
  const [triggerSubmitting, setTriggerSubmitting] = useState(false);

  // External "open this run" requests (e.g. from Findings/Clients tabs)
  useEffect(() => {
    if (runIdToOpen) {
      setSelectedRunId(runIdToOpen);
      onRunOpened?.();
    }
  }, [runIdToOpen, onRunOpened]);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: 200 };
      if (clientFilter) params.client_user_id = clientFilter.id;
      if (statusFilter) params.status = statusFilter;
      if (tierFilter) params.tier = tierFilter;
      // Date filters go to the backend (it indexes created_at) so the 50-row
      // default doesn't truncate older matching runs before we filter them.
      if (dateFrom) params.from = new Date(dateFrom).toISOString();
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        params.to = end.toISOString();
      }
      const data = await listOpsRuns(params);
      setRuns(data);
    } catch (err) {
      showToast(`Failed to load runs: ${err.message || 'unknown error'}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [clientFilter, statusFilter, tierFilter, dateFrom, dateTo, showToast]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    listOpsRunDefinitions()
      .then(setDefinitions)
      .catch(() => setDefinitions([]));
    listOpsClients()
      .then(setClients)
      .catch(() => setClients([]));
  }, []);

  const clientById = useMemo(() => {
    const map = new Map();
    for (const c of clients) map.set(c.id, c);
    return map;
  }, [clients]);

  const columns = useMemo(
    () => [
      {
        id: 'client',
        label: 'Client',
        render: (row) => {
          const c = clientById.get(row.client_user_id);
          return c ? clientLabel(c) : row.client_user_id?.slice(0, 8) || '—';
        }
      },
      {
        id: 'definition',
        label: 'Definition',
        render: (row) => {
          const d = definitions.find((dd) => dd.id === row.run_definition_id);
          return d?.name || row.tier;
        }
      },
      { id: 'tier', label: 'Tier' },
      {
        id: 'status',
        label: 'Status',
        render: (row) => <StatusChip label={row.status} color={STATUS_PALETTE[row.status] || 'default'} />
      },
      {
        id: 'duration_ms',
        label: 'Duration',
        render: (row) => formatDuration(row.duration_ms)
      },
      {
        id: 'cost_estimate_cents',
        label: 'Cost',
        render: (row) => `${row.cost_estimate_cents || 0}¢`
      },
      {
        id: 'created_at',
        label: 'Started',
        render: (row) => formatTimestamp(row.started_at || row.created_at)
      }
    ],
    [clientById, definitions]
  );

  const handleTrigger = async () => {
    if (!triggerClient || !triggerDef) {
      showToast('Pick a client and a run definition', 'warning');
      return;
    }
    setTriggerSubmitting(true);
    try {
      const created = await triggerOpsRun({
        client_user_id: triggerClient.id,
        run_definition_id: triggerDef
      });
      showToast(`Run ${created.id?.slice(0, 8)} queued`, 'success');
      setTriggerOpen(false);
      setTriggerDef('');
      setTriggerClient(null);
      loadRuns();
    } catch (err) {
      showToast(`Trigger failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setTriggerSubmitting(false);
    }
  };

  if (selectedRunId) {
    return (
      <RunDetail
        runId={selectedRunId}
        onBack={() => {
          setSelectedRunId(null);
          onCloseRun?.();
        }}
      />
    );
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Autocomplete
          size="small"
          sx={{ minWidth: 240 }}
          options={clients}
          getOptionLabel={clientLabel}
          value={clientFilter}
          onChange={(_, v) => setClientFilter(v)}
          renderInput={(params) => <TextField {...params} label="Client" />}
          isOptionEqualToValue={(a, b) => a.id === b.id}
        />
        <Box sx={{ minWidth: 160 }}>
          <SelectField
            label="Status"
            size="small"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={STATUS_FILTER_OPTIONS}
          />
        </Box>
        <Box sx={{ minWidth: 160 }}>
          <SelectField
            label="Tier"
            size="small"
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value)}
            options={TIER_FILTER_OPTIONS}
          />
        </Box>
        <TextField
          size="small"
          label="From"
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <TextField
          size="small"
          label="To"
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <LoadingButton startIcon={<RefreshIcon />} onClick={loadRuns} loading={loading} loadingLabel="Loading" variant="outlined">
          Refresh
        </LoadingButton>
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<PlayArrowIcon />} variant="contained" onClick={() => setTriggerOpen(true)}>
          Trigger run
        </Button>
      </Stack>

      <DataTable
        columns={columns}
        rows={runs}
        rowKey="id"
        loading={loading}
        paginated
        pageSize={25}
        onRowClick={(row) => setSelectedRunId(row.id)}
        emptyTitle="No runs yet"
        emptyMessage="Use Trigger run to queue a website check for a client."
      />

      <FormDialog
        open={triggerOpen}
        onClose={() => setTriggerOpen(false)}
        onSubmit={handleTrigger}
        title="Trigger ops run"
        loading={triggerSubmitting}
        submitLabel="Queue run"
        maxWidth="sm"
      >
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Picks a client and a run definition, queues the run for execution by the ops worker.
          </Typography>
          <Autocomplete
            size="small"
            options={clients}
            getOptionLabel={clientLabel}
            value={triggerClient}
            onChange={(_, v) => setTriggerClient(v)}
            renderInput={(params) => <TextField {...params} label="Client" required />}
            isOptionEqualToValue={(a, b) => a.id === b.id}
          />
          <SelectField
            label="Run definition"
            value={triggerDef}
            onChange={(e) => setTriggerDef(e.target.value)}
            required
            options={definitions.map((d) => ({ value: d.id, label: `${d.name} (${d.tier})` }))}
          />
        </Stack>
      </FormDialog>
    </Stack>
  );
}
