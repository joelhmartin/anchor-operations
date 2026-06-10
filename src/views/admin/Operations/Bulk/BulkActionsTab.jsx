import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import LoadingButton from 'ui-component/extended/LoadingButton';
import SelectField from 'ui-component/extended/SelectField';
import StatusChip from 'ui-component/extended/StatusChip';
import EmptyState from 'ui-component/extended/EmptyState';
import DataTable from 'ui-component/extended/DataTable';
import { useToast } from 'contexts/ToastContext';
import {
  cancelBulkJob,
  createBulkJob,
  fetchBulkActions,
  fetchBulkJob,
  fetchOperationsSites
} from 'api/operations';

function paramFields(action) {
  const fields = action?.requires_params || [];
  return fields;
}

function ResultPreview({ status, result }) {
  if (status === 'queued') return <Typography variant="caption">queued</Typography>;
  if (status === 'running') return <Typography variant="caption">running…</Typography>;
  if (!result) return null;
  if (result.error) {
    return (
      <Typography variant="caption" color="error">
        {String(result.error).slice(0, 200)}
      </Typography>
    );
  }
  // Compact summary heuristics for common shapes
  if (Array.isArray(result.plugins)) {
    const active = result.plugins.filter((p) => p.status === 'active').length;
    return (
      <Typography variant="caption">
        {result.plugins.length} plugins ({active} active)
      </Typography>
    );
  }
  if ('gtm_present' in result) {
    return (
      <Stack direction="row" spacing={0.5}>
        <Chip size="small" color={result.gtm_present ? 'success' : 'default'} label={`GTM ${result.gtm_present ? 'yes' : 'no'}`} />
        <Chip size="small" color={result.ga4_present ? 'success' : 'default'} label={`GA4 ${result.ga4_present ? 'yes' : 'no'}`} />
        <Chip size="small" color={result.fb_pixel_present ? 'success' : 'default'} label={`Pixel ${result.fb_pixel_present ? 'yes' : 'no'}`} />
      </Stack>
    );
  }
  if (result.exit_code != null) {
    return (
      <Typography variant="caption">
        exit {result.exit_code}
      </Typography>
    );
  }
  return <Typography variant="caption">{Object.keys(result).slice(0, 3).join(', ')}</Typography>;
}

export default function BulkActionsTab() {
  const { showToast: toast } = useToast();
  const [actions, setActions] = useState([]);
  const [actionKey, setActionKey] = useState('verify_tracking_install');
  const [params, setParams] = useState({});
  const [sites, setSites] = useState([]);
  const [selected, setSelected] = useState({}); // siteId -> boolean
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    Promise.all([fetchBulkActions(), fetchOperationsSites()])
      .then(([a, s]) => {
        setActions(a);
        setSites(s);
      })
      .catch((err) => toast(err.response?.data?.message || 'Failed to load bulk surface', 'error'))
      .finally(() => setLoading(false));
  }, [toast]);

  // Poll the active job until done
  useEffect(() => {
    if (!job || ['completed', 'cancelled', 'failed'].includes(job.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return undefined;
    }
    pollRef.current = setInterval(async () => {
      try {
        const fresh = await fetchBulkJob(job.id);
        setJob(fresh);
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [job?.id, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const action = useMemo(() => actions.find((a) => a.key === actionKey), [actions, actionKey]);
  const requiredFields = paramFields(action);
  const selectedSiteIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([id]) => id),
    [selected]
  );

  const allSelected = sites.length > 0 && selectedSiteIds.length === sites.length;

  function toggleAll() {
    if (allSelected) setSelected({});
    else {
      const next = {};
      sites.forEach((s) => {
        next[s.id] = true;
      });
      setSelected(next);
    }
  }

  async function submit() {
    setSubmitting(true);
    try {
      const created = await createBulkJob({
        action: actionKey,
        params,
        site_ids: selectedSiteIds
      });
      setJob(created);
      toast(`Job started for ${selectedSiteIds.length} sites`, 'success');
    } catch (err) {
      toast(err.response?.data?.message || err.message || 'Submit failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      const updated = await cancelBulkJob(job.id);
      setJob(updated);
      toast('Job cancelled', 'info');
    } catch (err) {
      toast(err.response?.data?.message || 'Cancel failed', 'error');
    }
  }

  const targets = job?.result_json?.targets || {};
  const targetRows = job
    ? Object.entries(targets).map(([envId, info]) => ({
        env_id: envId,
        status: info.status,
        duration_ms: info.duration_ms,
        result: info.result
      }))
    : [];

  const progress = job ? (job.completed_targets / Math.max(1, job.total_targets)) * 100 : 0;

  return (
    <Box>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h4" sx={{ flex: 1 }}>
          Bulk Actions
        </Typography>
      </Stack>

      <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
        Runs are user-triggered only — no scheduled background runs.
      </Alert>

      {!job && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack spacing={2}>
            <SelectField
              label="Action"
              value={actionKey}
              onChange={(e) => {
                setActionKey(e.target.value);
                setParams({});
              }}
              options={actions.map((a) => ({
                value: a.key,
                label: `${a.label}${a.mutating ? ' (mutating)' : ''}`
              }))}
              fullWidth={false}
              sx={{ minWidth: 320 }}
              disabled={loading}
            />

            {requiredFields.map((field) => (
              <TextField
                key={field}
                size="small"
                label={field}
                value={params[field] || ''}
                onChange={(e) => setParams({ ...params, [field]: e.target.value })}
                sx={{ maxWidth: 400 }}
              />
            ))}

            {action?.mutating && actionKey === 'plugin_update' && (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={params.dry_run !== false}
                    onChange={(e) => setParams({ ...params, dry_run: e.target.checked })}
                  />
                }
                label="Dry-run (preview without changing anything)"
              />
            )}

            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle2">Targets</Typography>
              <Chip size="small" label={`${selectedSiteIds.length} of ${sites.length} selected`} />
              <Box sx={{ flex: 1 }} />
              <FormControlLabel
                control={<Checkbox checked={allSelected} indeterminate={!allSelected && selectedSiteIds.length > 0} onChange={toggleAll} />}
                label="Select all"
              />
            </Stack>

            <Box sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
              {sites.map((s) => (
                <FormControlLabel
                  key={s.id}
                  control={
                    <Checkbox
                      size="small"
                      checked={Boolean(selected[s.id])}
                      onChange={(e) => setSelected({ ...selected, [s.id]: e.target.checked })}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2">{s.display_name || s.site_name}</Typography>
                      {s.primary_domain && (
                        <Typography variant="caption" color="text.secondary">
                          {s.primary_domain}
                        </Typography>
                      )}
                    </Stack>
                  }
                  sx={{ display: 'flex', m: 0 }}
                />
              ))}
            </Box>

            <Box>
              <LoadingButton
                variant="contained"
                onClick={submit}
                loading={submitting}
                loadingLabel="Starting…"
                disabled={selectedSiteIds.length === 0}
              >
                Run on {selectedSiteIds.length} site{selectedSiteIds.length === 1 ? '' : 's'}
              </LoadingButton>
            </Box>
          </Stack>
        </Paper>
      )}

      {job && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
            <Typography variant="subtitle1" sx={{ flex: 1 }}>
              Job {job.id.slice(0, 8)} — {job.action}
            </Typography>
            <StatusChip
              status={
                job.status === 'completed'
                  ? 'completed'
                  : job.status === 'cancelled'
                    ? 'inactive'
                    : job.status === 'failed'
                      ? 'failed'
                      : 'in_progress'
              }
              label={job.status}
            />
            {['queued', 'running'].includes(job.status) && (
              <LoadingButton size="small" variant="outlined" onClick={cancel}>
                Cancel
              </LoadingButton>
            )}
            <LoadingButton size="small" variant="text" onClick={() => setJob(null)}>
              New job
            </LoadingButton>
          </Stack>

          <LinearProgress variant="determinate" value={progress} sx={{ mb: 2 }} />
          <Typography variant="caption" color="text.secondary">
            {job.completed_targets} of {job.total_targets} complete
          </Typography>

          <DataTable
            sx={{ mt: 2 }}
            columns={[
              { id: 'env_id', label: 'Environment', render: (r) => <code>{r.env_id.slice(0, 8)}</code> },
              {
                id: 'status',
                label: 'Status',
                render: (r) => (
                  <StatusChip
                    status={
                      r.status === 'success' ? 'completed' : r.status === 'error' ? 'failed' : r.status === 'running' ? 'in_progress' : 'pending'
                    }
                    label={r.status}
                  />
                )
              },
              { id: 'duration_ms', label: 'Duration', render: (r) => (r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—') },
              { id: 'result', label: 'Result', render: (r) => <ResultPreview status={r.status} result={r.result} /> }
            ]}
            rows={targetRows}
            rowKey="env_id"
            paginated
            pageSize={20}
            emptyTitle="No targets yet."
          />
        </Paper>
      )}

      {!job && !loading && sites.length === 0 && (
        <EmptyState
          title="No sites yet."
          message="Sync from Kinsta on the Sites tab first."
        />
      )}
    </Box>
  );
}
