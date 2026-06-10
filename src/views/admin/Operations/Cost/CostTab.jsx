/**
 * CostTab — Phase 9 token spend by client / tier / sub-agent.
 *
 * Reads /api/ops/cost-summary and surfaces % of monthly cap with color-coded
 * chips. Per-row "Edit cap" persists via /api/ops/clients/:id/cap.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Chip, Stack, TextField, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import MainCard from 'ui-component/cards/MainCard';
import DataTable from 'ui-component/extended/DataTable';
import FormDialog from 'ui-component/extended/FormDialog';
import LoadingButton from 'ui-component/extended/LoadingButton';
import { useToast } from 'contexts/ToastContext';
import { getOpsCostSummary, updateClientOpsCap } from 'api/ops';

function dollars(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

function pctColor(pct) {
  if (pct >= 100) return 'error';
  if (pct >= 80) return 'warning';
  return 'success';
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function CostTab() {
  const { showToast } = useToast();
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [editCap, setEditCap] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getOpsCostSummary({ month });
      setRows(data);
    } catch (err) {
      showToast(`Couldn't load cost summary: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [month, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    const totalMtd = rows.reduce((acc, r) => acc + (r.mtd_cents || 0), 0);
    const day = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const forecast = day > 0 ? Math.round((totalMtd * daysInMonth) / day) : totalMtd;
    return { totalMtd, forecast };
  }, [rows]);

  const openEdit = (row) => {
    setEditTarget(row);
    setEditCap(row.cap_cents != null ? String(row.cap_cents) : '500');
  };

  const submitEdit = async () => {
    if (!editTarget) return;
    const cents = parseInt(editCap, 10);
    if (!Number.isFinite(cents) || cents < 0) {
      showToast('Cap must be a non-negative integer (cents)', 'warning');
      return;
    }
    setEditSubmitting(true);
    try {
      await updateClientOpsCap(editTarget.client_user_id, cents);
      showToast(`Cap set to ${dollars(cents)}`, 'success');
      setEditTarget(null);
      load();
    } catch (err) {
      showToast(`Update failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setEditSubmitting(false);
    }
  };

  const columns = useMemo(
    () => [
      { id: 'client_name', label: 'Client' },
      {
        id: 'mtd_cents',
        label: 'MTD',
        render: (r) => dollars(r.mtd_cents)
      },
      {
        id: 'cap_cents',
        label: 'Cap',
        render: (r) => (r.cap_cents != null ? dollars(r.cap_cents) : '—')
      },
      {
        id: '_pct',
        label: '% of cap',
        render: (r) => {
          if (!r.cap_cents) return '—';
          const pct = Math.round(((r.mtd_cents || 0) / r.cap_cents) * 100);
          return <Chip size="small" label={`${pct}%`} color={pctColor(pct)} />;
        }
      },
      { id: 'runs_count', label: 'Runs' },
      {
        id: '_tier',
        label: 'By tier',
        render: (r) => (
          <Stack direction="row" spacing={0.5}>
            <Chip size="small" variant="outlined" label={`D ${dollars(r.by_tier?.daily_essential)}`} />
            <Chip size="small" variant="outlined" label={`W ${dollars(r.by_tier?.weekly_deep)}`} />
            <Chip size="small" variant="outlined" label={`M ${dollars(r.by_tier?.monthly_audit)}`} />
          </Stack>
        )
      },
      {
        id: '_subagent',
        label: 'Top sub-agents',
        render: (r) => {
          const entries = Object.entries(r.by_subagent || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);
          if (entries.length === 0) return '—';
          return (
            <Stack direction="row" spacing={0.5}>
              {entries.map(([name, cents]) => (
                <Chip key={name} size="small" label={`${name}: ${dollars(cents)}`} />
              ))}
            </Stack>
          );
        }
      },
      {
        id: '_actions',
        label: '',
        render: (r) => (
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <LoadingButton size="small" startIcon={<EditIcon />} onClick={() => openEdit(r)}>
              Edit cap
            </LoadingButton>
          </Box>
        )
      }
    ],
    []
  );

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Typography variant="h4">Cost</Typography>
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small"
          label="Month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          placeholder="YYYY-MM"
          sx={{ width: 140 }}
        />
        <LoadingButton
          startIcon={<RefreshIcon />}
          variant="outlined"
          onClick={load}
          loading={loading}
          loadingLabel="Loading"
        >
          Refresh
        </LoadingButton>
      </Stack>

      <MainCard>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Agency MTD spend
            </Typography>
            <Typography variant="h3">{dollars(totals.totalMtd)}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Forecast (this month)
            </Typography>
            <Typography variant="h3">{dollars(totals.forecast)}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Clients with spend
            </Typography>
            <Typography variant="h3">{rows.length}</Typography>
          </Box>
        </Stack>
      </MainCard>

      <MainCard contentSX={{ p: 0 }}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey="client_user_id"
          loading={loading}
          paginated
          pageSize={25}
          emptyTitle="No spend yet this month"
          emptyMessage="As runs complete, their costs appear here."
        />
      </MainCard>

      <FormDialog
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        onSubmit={submitEdit}
        title={`Edit cap for ${editTarget?.client_name || ''}`}
        loading={editSubmitting}
        submitLabel="Save cap"
      >
        <TextField
          label="Monthly cap (cents)"
          value={editCap}
          onChange={(e) => setEditCap(e.target.value)}
          type="number"
          fullWidth
          helperText={`= ${dollars(parseInt(editCap, 10) || 0)}`}
        />
      </FormDialog>
    </Stack>
  );
}
