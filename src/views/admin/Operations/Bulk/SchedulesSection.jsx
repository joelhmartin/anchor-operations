import { useEffect, useState, useCallback } from 'react';
import { Box, Stack, IconButton, Tooltip, Switch, Chip } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import DataTable from 'ui-component/extended/DataTable';
import LoadingButton from 'ui-component/extended/LoadingButton';
import ConfirmDialog from 'ui-component/extended/ConfirmDialog';
import { useToast } from 'contexts/ToastContext';
import { getErrorMessage } from 'utils/errors';
import { listSchedules, deleteSchedule, runScheduleNow, updateSchedule } from 'api/opsBulk';
import ScheduleDialog from './ScheduleDialog';

function formatCadence(s) {
  if (s.cadence === 'daily') return `Daily @ ${String(s.hour_local).padStart(2, '0')}:00`;
  if (s.cadence === 'weekly') {
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(s.day_of_week) || 0];
    return `Weekly · ${dow} @ ${String(s.hour_local).padStart(2, '0')}:00`;
  }
  if (s.cadence === 'monthly') return `Monthly · day ${s.day_of_month} @ ${String(s.hour_local).padStart(2, '0')}:00`;
  return s.cadence;
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

export default function SchedulesSection() {
  const { showToast } = useToast();
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmRun, setConfirmRun] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listSchedules();
      setSchedules(rows);
    } catch (e) {
      showToast({ type: 'error', message: `Failed to load schedules: ${getErrorMessage(e)}` });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    reload();
  }, [reload]);

  const onCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const onEdit = (row) => {
    setEditing(row);
    setDialogOpen(true);
  };

  const onDialogSaved = (saved, mode) => {
    setSchedules((prev) => {
      if (mode === 'create') return [...prev, saved];
      return prev.map((r) => (r.id === saved.id ? saved : r));
    });
    showToast({
      type: 'success',
      message: mode === 'create' ? 'Schedule created' : 'Schedule updated'
    });
  };

  const onToggleEnabled = async (row, enabled) => {
    setBusyId(row.id);
    const prev = row.enabled;
    setSchedules((s) => s.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      const updated = await updateSchedule(row.id, { enabled });
      setSchedules((s) => s.map((r) => (r.id === row.id ? updated : r)));
      showToast({ type: 'success', message: enabled ? 'Schedule enabled' : 'Schedule paused' });
    } catch (e) {
      setSchedules((s) => s.map((r) => (r.id === row.id ? { ...r, enabled: prev } : r)));
      showToast({ type: 'error', message: `Failed: ${getErrorMessage(e)}` });
    } finally {
      setBusyId(null);
    }
  };

  const onConfirmDelete = async () => {
    if (!confirmDelete) return;
    setBusyId(confirmDelete.id);
    try {
      await deleteSchedule(confirmDelete.id);
      setSchedules((s) => s.filter((r) => r.id !== confirmDelete.id));
      showToast({ type: 'success', message: 'Schedule deleted' });
    } catch (e) {
      showToast({ type: 'error', message: `Failed to delete: ${getErrorMessage(e)}` });
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  };

  const onConfirmRun = async () => {
    if (!confirmRun) return;
    setBusyId(confirmRun.id);
    try {
      const out = await runScheduleNow(confirmRun.id);
      showToast({
        type: 'success',
        message: `Bulk run started — ${out.enqueued || 0} runs queued across ${out.clientCount || 0} clients, ${out.skipped || 0} skipped`
      });
    } catch (e) {
      showToast({ type: 'error', message: `Failed to run: ${getErrorMessage(e)}` });
    } finally {
      setBusyId(null);
      setConfirmRun(null);
    }
  };

  const columns = [
    { id: 'name', label: 'Name', sortable: true },
    {
      id: 'skill_ids',
      label: 'Skills',
      render: (row) => <Chip size="small" label={`${(row.skill_ids || []).length} skill${(row.skill_ids || []).length === 1 ? '' : 's'}`} />
    },
    { id: 'cadence', label: 'Cadence', render: (row) => formatCadence(row) },
    { id: 'last_run_at', label: 'Last run', render: (r) => formatDate(r.last_run_at) },
    { id: 'next_run_at', label: 'Next run', render: (r) => formatDate(r.next_run_at) },
    {
      id: 'enabled',
      label: 'Enabled',
      render: (row) => (
        <Switch
          checked={!!row.enabled}
          disabled={busyId === row.id}
          onChange={(e) => onToggleEnabled(row, e.target.checked)}
          onClick={(e) => e.stopPropagation()}
        />
      )
    },
    {
      id: 'actions',
      label: 'Actions',
      render: (row) => (
        <Stack direction="row" spacing={0.5} onClick={(e) => e.stopPropagation()}>
          <Tooltip title="Edit">
            <IconButton size="small" onClick={() => onEdit(row)}>
              <EditIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Run now">
            <span>
              <IconButton size="small" disabled={busyId === row.id} onClick={() => setConfirmRun(row)}>
                <PlayArrowIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Delete">
            <span>
              <IconButton size="small" disabled={busyId === row.id} onClick={() => setConfirmDelete(row)}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      )
    }
  ];

  return (
    <Box>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }}>
        <LoadingButton variant="contained" startIcon={<AddIcon />} onClick={onCreate}>
          New schedule
        </LoadingButton>
      </Stack>

      <DataTable
        columns={columns}
        rows={schedules}
        rowKey="id"
        searchable
        searchFields={['name']}
        paginated
        pageSize={10}
        loading={loading}
        emptyTitle="No schedules yet"
        emptyMessage="Create a bulk schedule to run skills across all active clients on a cadence."
      />

      <ScheduleDialog open={dialogOpen} schedule={editing} onClose={() => setDialogOpen(false)} onSaved={onDialogSaved} />

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete schedule?"
        message={`This will permanently delete "${confirmDelete?.name}". Existing runs are kept.`}
        confirmLabel="Delete"
        confirmColor="error"
        onClose={() => setConfirmDelete(null)}
        onConfirm={onConfirmDelete}
      />

      <ConfirmDialog
        open={!!confirmRun}
        title="Run schedule now?"
        message={`Trigger an immediate bulk run for "${confirmRun?.name}".`}
        confirmLabel="Run now"
        onClose={() => setConfirmRun(null)}
        onConfirm={onConfirmRun}
      />
    </Box>
  );
}
