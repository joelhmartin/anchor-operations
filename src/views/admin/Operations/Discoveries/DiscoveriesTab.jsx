/**
 * DiscoveriesTab — renamed from FindingsTab in the Command Center pivot.
 *
 * Cross-run discovery feed with filters, status (open/investigating/blocked/
 * resolved/ignored), and ack/resolve/ignore actions. Highlights
 * `budget.throttled` and `correlation.*` rows with distinct chip colors.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Autocomplete, Box, Button, Checkbox, Chip, Stack, TextField } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import DataTable from 'ui-component/extended/DataTable';
import StatusChip from 'ui-component/extended/StatusChip';
import LoadingButton from 'ui-component/extended/LoadingButton';
import SelectField from 'ui-component/extended/SelectField';
import FormDialog from 'ui-component/extended/FormDialog';
import { useToast } from 'contexts/ToastContext';
import { listOpsFindings, acknowledgeOpsFinding, resolveOpsFinding, listOpsClients } from 'api/ops';
import { clientLabel } from '../_clientLabel';
import DiscoveryDetail from './DiscoveryDetail';

const SEVERITY_OPTIONS = [
  { value: '', label: 'Any severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' }
];

function severityColor(sev) {
  return { critical: 'error', warning: 'warning', info: 'info' }[sev] || 'default';
}

function categoryChip(category) {
  if (!category) return null;
  if (category.startsWith('correlation.')) {
    return <Chip size="small" label={category} color="error" variant="outlined" />;
  }
  if (category === 'budget.throttled') {
    return <Chip size="small" label={category} color="warning" />;
  }
  return <Chip size="small" label={category} variant="outlined" />;
}

function fmt(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function DiscoveriesTab({ onOpenRun, onOpenDiscovery, activeClientId }) {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialStatus = searchParams.get('status') || '';
  const initialSeverity = searchParams.get('severity') || '';
  const openDiscoveryId = searchParams.get('discovery') || null;

  const [findings, setFindings] = useState([]);
  const [clients, setClients] = useState([]);
  const [clientFilter, setClientFilter] = useState(null);
  const [severity, setSeverity] = useState(initialSeverity);
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [openOnly, setOpenOnly] = useState(!initialStatus);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [resolveTarget, setResolveTarget] = useState(null);
  const [resolveNote, setResolveNote] = useState('');
  const [resolveSubmitting, setResolveSubmitting] = useState(false);

  useEffect(() => {
    const nextSeverity = searchParams.get('severity') || '';
    const nextStatus = searchParams.get('status') || '';
    setSeverity(nextSeverity);
    setStatusFilter(nextStatus);
    setOpenOnly(!nextStatus);
  }, [searchParams]);

  const closeDetail = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('discovery');
    setSearchParams(next, { replace: true });
  };

  const openDetail = (id) => {
    if (onOpenDiscovery) {
      onOpenDiscovery(id);
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('discovery', id);
    setSearchParams(next, { replace: false });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      const effectiveClientId = activeClientId || clientFilter?.id || null;
      if (effectiveClientId) params.client_user_id = effectiveClientId;
      if (severity) params.severity = severity;
      if (statusFilter) params.status = statusFilter;
      else if (openOnly) params.open = 'true';
      const rows = await listOpsFindings(params);
      setFindings(rows);
      setSelected(new Set());
    } catch (err) {
      showToast(`Couldn't load findings: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [activeClientId, clientFilter, severity, statusFilter, openOnly, showToast]);

  useEffect(() => {
    load();
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

  const patchFinding = useCallback((updated) => {
    if (!updated?.id) return;
    setFindings((prev) => prev.map((f) => (f.id === updated.id ? { ...f, ...updated } : f)));
  }, []);

  const handleAck = async (id) => {
    try {
      const updated = await acknowledgeOpsFinding(id);
      patchFinding(updated);
      showToast('Finding acknowledged', 'success');
    } catch (err) {
      showToast(`Ack failed: ${err.response?.data?.message || err.message}`, 'error');
    }
  };

  const handleBulkAck = async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const updated = await acknowledgeOpsFinding(id);
        patchFinding(updated);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setSelected(new Set());
    showToast(failed > 0 ? `Acknowledged ${ok}, ${failed} failed` : `Acknowledged ${ok} findings`, failed > 0 ? 'warning' : 'success');
  };

  const submitResolve = async () => {
    if (!resolveTarget) return;
    setResolveSubmitting(true);
    try {
      const updated = await resolveOpsFinding(resolveTarget.id, { resolution_note: resolveNote || null });
      patchFinding(updated);
      showToast('Finding resolved', 'success');
      setResolveTarget(null);
      setResolveNote('');
    } catch (err) {
      showToast(`Resolve failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setResolveSubmitting(false);
    }
  };

  const columns = useMemo(
    () => [
      {
        id: '_select',
        label: '',
        width: 40,
        render: (row) => (
          <Checkbox
            size="small"
            checked={selected.has(row.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(row.id);
              else next.delete(row.id);
              setSelected(next);
            }}
          />
        )
      },
      {
        id: 'created_at',
        label: 'When',
        render: (r) => fmt(r.created_at)
      },
      {
        id: 'severity',
        label: 'Severity',
        render: (r) => <Chip size="small" label={r.severity || 'info'} color={severityColor(r.severity)} />
      },
      {
        id: 'category',
        label: 'Category',
        render: (r) => categoryChip(r.category)
      },
      {
        id: 'summary',
        label: 'Summary',
        render: (r) => r.summary || '—'
      },
      {
        id: 'client',
        label: 'Client',
        render: (r) => clientNameById.get(r.client_user_id) || r.client_user_id?.slice(0, 8) || '—'
      },
      {
        id: 'status',
        label: 'Status',
        render: (r) => {
          // r.status is the source of truth (post-pivot). Fall back to legacy
          // timestamps for any row that might not have been migrated yet.
          const s = r.status || (r.resolved_at ? 'resolved' : r.acknowledged_at ? 'investigating' : 'open');
          if (s === 'resolved') return <StatusChip status="completed" label="Resolved" />;
          if (s === 'ignored') return <StatusChip status="failed" label="Ignored" />;
          if (s === 'blocked') return <StatusChip status="failed" label="Blocked" />;
          if (s === 'investigating') return <StatusChip status="in_progress" label="Investigating" />;
          return <StatusChip status="pending" label="Open" />;
        }
      },
      {
        id: '_run',
        label: 'Run',
        render: (r) => (
          <Button
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onOpenRun?.(r.run_id);
            }}
          >
            Open
          </Button>
        )
      },
      {
        id: '_actions',
        label: 'Actions',
        render: (r) => {
          const s = r.status || (r.resolved_at ? 'resolved' : r.acknowledged_at ? 'investigating' : 'open');
          const canAck = s === 'open';
          const canResolve = s !== 'resolved' && s !== 'ignored';
          return (
            <Stack direction="row" spacing={0.5}>
              {canAck && (
                <Button
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAck(r.id);
                  }}
                >
                  Ack
                </Button>
              )}
              {canResolve && (
                <Button
                  size="small"
                  color="success"
                  onClick={(e) => {
                    e.stopPropagation();
                    setResolveTarget(r);
                    setResolveNote('');
                  }}
                >
                  Resolve
                </Button>
              )}
            </Stack>
          );
        }
      }
    ],
    [selected, clientNameById, onOpenRun] // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        {!activeClientId && (
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
        )}
        <Box sx={{ minWidth: 160 }}>
          <SelectField
            label="Severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            options={SEVERITY_OPTIONS}
            size="small"
          />
        </Box>
        <Box sx={{ minWidth: 160 }}>
          <SelectField
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              { value: 'open', label: 'Open' },
              { value: 'investigating', label: 'Investigating' },
              { value: 'blocked', label: 'Blocked' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'ignored', label: 'Ignored' }
            ]}
            size="small"
          />
        </Box>
        {!statusFilter && (
          <Button size="small" variant={openOnly ? 'contained' : 'outlined'} onClick={() => setOpenOnly((v) => !v)}>
            {openOnly ? 'Open only' : 'Including resolved'}
          </Button>
        )}
        <LoadingButton startIcon={<RefreshIcon />} onClick={load} loading={loading} loadingLabel="Loading" variant="outlined">
          Refresh
        </LoadingButton>
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<DoneAllIcon />} variant="contained" disabled={selected.size === 0} onClick={handleBulkAck}>
          Ack selected ({selected.size})
        </Button>
      </Stack>

      <DataTable
        columns={columns}
        rows={findings}
        rowKey="id"
        loading={loading}
        paginated
        pageSize={25}
        emptyTitle="No findings"
        emptyMessage="Adjust the filters or trigger a run to populate."
        onRowClick={(row) => openDetail(row.id)}
      />

      {openDiscoveryId ? <DiscoveryDetail discoveryId={openDiscoveryId} onClose={closeDetail} onOpenRun={onOpenRun} /> : null}

      <FormDialog
        open={Boolean(resolveTarget)}
        onClose={() => setResolveTarget(null)}
        onSubmit={submitResolve}
        title="Resolve finding"
        loading={resolveSubmitting}
        submitLabel="Resolve"
        submitColor="success"
      >
        <TextField
          label="Resolution note (optional)"
          value={resolveNote}
          onChange={(e) => setResolveNote(e.target.value)}
          multiline
          minRows={3}
          fullWidth
        />
      </FormDialog>
    </Stack>
  );
}
