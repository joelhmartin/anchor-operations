import { useEffect, useState, useCallback } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import DataTable from 'ui-component/extended/DataTable';
import StatusChip from 'ui-component/extended/StatusChip';
import { useToast } from 'contexts/ToastContext';
import { getErrorMessage } from 'utils/errors';
import { listBulkRuns } from 'api/opsBulk';
import BulkRunDetailDrawer from './BulkRunDetailDrawer';

function fmtDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return date.toLocaleDateString();
}

function fmtMoney(cents) {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

const PAGE_SIZE = 25;

export default function RunsSection() {
  const { showToast } = useToast();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openRunId, setOpenRunId] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const out = await listBulkRuns({ limit: 100, offset: 0 });
      setRuns(out.runs || []);
    } catch (e) {
      showToast({ type: 'error', message: `Failed to load bulk runs: ${getErrorMessage(e)}` });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { reload(); }, [reload]);

  const columns = [
    {
      id: 'schedule_name',
      label: 'Schedule',
      render: (r) => r.schedule_name || (r.trigger === 'manual' ? <em>Manual</em> : '—')
    },
    {
      id: 'started_at',
      label: 'Started',
      render: (r) => (
        <Box title={r.started_at ? new Date(r.started_at).toLocaleString() : ''}>{fmtDate(r.started_at)}</Box>
      )
    },
    {
      id: 'status',
      label: 'Status',
      render: (r) => <StatusChip status={r.status} />
    },
    {
      id: 'client_count',
      label: 'Clients',
      render: (r) => r.client_count ?? 0,
      align: 'right'
    },
    {
      id: 'skipped_count',
      label: 'Skipped',
      render: (r) => (
        <Typography variant="body2" color="text.secondary">{r.skipped_count ?? 0}</Typography>
      ),
      align: 'right'
    },
    {
      id: 'findings_count',
      label: 'Findings',
      render: (r) => r.findings_count ?? 0,
      align: 'right'
    },
    {
      id: 'cost_cents',
      label: 'Cost',
      render: (r) => fmtMoney(r.cost_cents),
      align: 'right'
    }
  ];

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Latest 100 bulk runs. Click a row to see per-client breakdown.
        </Typography>
      </Stack>

      <DataTable
        columns={columns}
        rows={runs}
        rowKey="id"
        paginated
        pageSize={PAGE_SIZE}
        loading={loading}
        emptyTitle="No bulk runs yet"
        emptyMessage="Trigger a schedule (or wait for one to fire) to see runs here."
        onRowClick={(r) => setOpenRunId(r.id)}
      />

      <BulkRunDetailDrawer
        runId={openRunId}
        open={!!openRunId}
        onClose={() => setOpenRunId(null)}
      />
    </Box>
  );
}
