import { useEffect, useMemo, useState } from 'react';
import { Stack, Typography } from '@mui/material';
import SelectField from 'ui-component/extended/SelectField';
import DataTable from 'ui-component/extended/DataTable';
import StatusChip from 'ui-component/extended/StatusChip';
import { fetchEnvCommands } from 'api/operations';
import { useToast } from 'contexts/ToastContext';

function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export default function SiteCommandHistory({ environments }) {
  const { showToast: toast } = useToast();
  const liveEnv = useMemo(() => environments.find((e) => e.is_live) || environments[0], [environments]);
  const [envId, setEnvId] = useState(liveEnv?.id || '');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!envId) return;
    setLoading(true);
    fetchEnvCommands(envId, { limit: 100 })
      .then((res) => setRows(res.commands || []))
      .catch((err) => toast(err.response?.data?.message || 'Failed to load history', 'error'))
      .finally(() => setLoading(false));
  }, [envId, toast]);

  const columns = useMemo(
    () => [
      { id: 'created_at', label: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
      { id: 'channel', label: 'Channel' },
      {
        id: 'command_summary',
        label: 'Command',
        render: (r) => (
          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
            {r.command_summary || '—'}
          </Typography>
        )
      },
      {
        id: 'exit_code',
        label: 'Exit',
        render: (r) =>
          r.exit_code == null ? (
            '—'
          ) : (
            <StatusChip status={r.exit_code === 0 ? 'completed' : 'failed'} label={String(r.exit_code)} />
          )
      },
      { id: 'duration_ms', label: 'Duration', render: (r) => formatDuration(r.duration_ms) },
      { id: 'triggered_by', label: 'Triggered by', render: (r) => r.triggered_by || '—' }
    ],
    []
  );

  return (
    <Stack spacing={2}>
      <SelectField
        label="Environment"
        value={envId}
        onChange={(e) => setEnvId(e.target.value)}
        options={environments.map((e) => ({
          value: e.id,
          label: `${e.environment_name}${e.is_live ? ' (live)' : ''}`
        }))}
        size="small"
        fullWidth={false}
        sx={{ minWidth: 320 }}
      />
      <DataTable
        columns={columns}
        rows={rows}
        rowKey="id"
        loading={loading}
        emptyTitle="No commands logged yet."
        paginated
        pageSize={20}
      />
    </Stack>
  );
}
