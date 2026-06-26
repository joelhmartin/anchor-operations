/**
 * ScheduleTab — Phase 9 run definitions CRUD.
 *
 * Lists ops_run_definitions with create + edit. check_set is edited as raw
 * JSON for v1; a richer builder is a v2 ask.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Switch, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import MainCard from 'ui-component/cards/MainCard';
import SubCard from 'ui-component/cards/SubCard';
import DataTable from 'ui-component/extended/DataTable';
import FormDialog from 'ui-component/extended/FormDialog';
import LoadingButton from 'ui-component/extended/LoadingButton';
import SelectField from 'ui-component/extended/SelectField';
import { useToast } from 'contexts/ToastContext';
import {
  listOpsRunDefinitions,
  createOpsRunDefinition,
  updateOpsRunDefinition,
  getChatModels
} from 'api/ops';

const TIER_OPTIONS = [
  { value: 'daily_essential', label: 'Daily essential' },
  { value: 'weekly_deep', label: 'Weekly deep' },
  { value: 'monthly_audit', label: 'Monthly audit' }
];

const TIER_CRONS = {
  daily_essential: '0 9 * * *',
  weekly_deep: '0 10 * * 1',
  monthly_audit: '0 11 1 * *'
};

const EMPTY_FORM = {
  name: '',
  description: '',
  tier: 'daily_essential',
  umbrellas: '',
  check_set: '[]',
  default_for_new_clients: false,
  model_id: ''
};

function fmt(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function ScheduleTab() {
  const { showToast } = useToast();
  const [defs, setDefs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [jsonError, setJsonError] = useState(null);
  const [modelOptions, setModelOptions] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listOpsRunDefinitions();
      setDefs(rows);
    } catch (err) {
      showToast(`Couldn't load run definitions: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
    getChatModels()
      .then((data) => {
        const opts = [{ value: '', label: 'Default (Gemini Flash)' }];
        for (const m of data.models || []) {
          opts.push({ value: m.id, label: m.label });
        }
        setModelOptions(opts);
      })
      .catch(() => {
        setModelOptions([{ value: '', label: 'Default (Gemini Flash)' }]);
      });
  }, [load]);

  const openCreate = () => {
    setEditTarget('new');
    setForm(EMPTY_FORM);
    setJsonError(null);
  };

  const openEdit = (def) => {
    setEditTarget(def);
    setForm({
      name: def.name || '',
      description: def.description || '',
      tier: def.tier || 'daily_essential',
      umbrellas: Array.isArray(def.umbrellas) ? def.umbrellas.join(', ') : '',
      check_set: JSON.stringify(def.check_set || [], null, 2),
      default_for_new_clients: Boolean(def.default_for_new_clients),
      model_id: def.model_id || ''
    });
    setJsonError(null);
  };

  const submit = async () => {
    let parsedCheckSet;
    try {
      parsedCheckSet = JSON.parse(form.check_set || '[]');
      if (!Array.isArray(parsedCheckSet)) throw new Error('check_set must be a JSON array');
      setJsonError(null);
    } catch (err) {
      setJsonError(err.message);
      return;
    }

    const payload = {
      name: form.name.trim(),
      description: form.description?.trim() || null,
      tier: form.tier,
      umbrellas: form.umbrellas
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      check_set: parsedCheckSet,
      default_for_new_clients: Boolean(form.default_for_new_clients),
      model_id: form.model_id || null
    };

    if (!payload.name) {
      showToast('Name is required', 'warning');
      return;
    }

    setSubmitting(true);
    try {
      if (editTarget === 'new') {
        await createOpsRunDefinition(payload);
        showToast('Run definition created', 'success');
      } else {
        await updateOpsRunDefinition(editTarget.id, payload);
        showToast('Run definition updated', 'success');
      }
      setEditTarget(null);
      load();
    } catch (err) {
      showToast(`Save failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const columns = useMemo(
    () => [
      { id: 'name', label: 'Name' },
      {
        id: 'tier',
        label: 'Tier',
        render: (r) => <Chip size="small" label={r.tier} />
      },
      {
        id: 'umbrellas',
        label: 'Umbrellas',
        render: (r) => (Array.isArray(r.umbrellas) ? r.umbrellas.join(', ') : '—')
      },
      {
        id: 'default_for_new_clients',
        label: 'Default',
        render: (r) => (r.default_for_new_clients ? 'Yes' : 'No')
      },
      {
        id: 'updated_at',
        label: 'Updated',
        render: (r) => fmt(r.updated_at)
      },
      {
        id: '_actions',
        label: '',
        render: (r) => (
          <Button size="small" startIcon={<EditIcon />} onClick={() => openEdit(r)}>
            Edit
          </Button>
        )
      }
    ],
    []
  );

  return (
    <Stack spacing={2}>
      <SubCard title="Tier defaults">
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          {TIER_OPTIONS.map((t) => (
            <Box key={t.value} sx={{ flex: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {t.label}
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {TIER_CRONS[t.value]}
              </Typography>
            </Box>
          ))}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Cloud Scheduler invokes /api/ops/internal/fanout on these crons. Per-client schedule_cron overrides take priority.
        </Typography>
      </SubCard>

      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="h4">Run Definitions</Typography>
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
        <Button startIcon={<AddIcon />} variant="contained" onClick={openCreate}>
          Create
        </Button>
      </Stack>

      <MainCard contentSX={{ p: 0 }}>
        <DataTable
          columns={columns}
          rows={defs}
          rowKey="id"
          loading={loading}
          emptyTitle="No run definitions"
          emptyMessage="Create one to start scheduling work for clients."
        />
      </MainCard>

      <FormDialog
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        onSubmit={submit}
        title={editTarget === 'new' ? 'Create run definition' : 'Edit run definition'}
        loading={submitting}
        submitLabel={editTarget === 'new' ? 'Create' : 'Save'}
        maxWidth="md"
      >
        <TextField
          label="Name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          fullWidth
        />
        <TextField
          label="Description"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          fullWidth
          multiline
          minRows={2}
        />
        <SelectField
          label="Tier"
          value={form.tier}
          onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value }))}
          options={TIER_OPTIONS}
          required
        />
        <SelectField
          label="Model override"
          value={form.model_id}
          onChange={(e) => setForm((f) => ({ ...f, model_id: e.target.value }))}
          options={modelOptions}
        />
        <TextField
          label="Umbrellas (comma-separated)"
          value={form.umbrellas}
          onChange={(e) => setForm((f) => ({ ...f, umbrellas: e.target.value }))}
          placeholder="web, ads, meta"
          fullWidth
        />
        <Stack direction="row" spacing={1} alignItems="center">
          <Switch
            checked={form.default_for_new_clients}
            onChange={(e) => setForm((f) => ({ ...f, default_for_new_clients: e.target.checked }))}
          />
          <Typography variant="body2">Default for new clients</Typography>
        </Stack>
        <TextField
          label="check_set (JSON array)"
          value={form.check_set}
          onChange={(e) => setForm((f) => ({ ...f, check_set: e.target.value }))}
          fullWidth
          multiline
          minRows={6}
          maxRows={20}
          InputProps={{ sx: { fontFamily: 'monospace', fontSize: 12 } }}
        />
        {jsonError && <Alert severity="error">{jsonError}</Alert>}
      </FormDialog>
    </Stack>
  );
}
