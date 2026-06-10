/**
 * ClientOpsView — Phase 9 per-client command center detail pane.
 *
 * Latest 3 runs + subscriptions editor + credentials health.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Stack,
  Switch,
  Typography
} from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import RefreshIcon from '@mui/icons-material/Refresh';
import VerifiedIcon from '@mui/icons-material/Verified';
import DeleteIcon from '@mui/icons-material/Delete';
import MainCard from 'ui-component/cards/MainCard';
import SubCard from 'ui-component/cards/SubCard';
import StatusChip from 'ui-component/extended/StatusChip';
import LoadingButton from 'ui-component/extended/LoadingButton';
import EmptyState from 'ui-component/extended/EmptyState';
import ConfirmDialog from 'ui-component/extended/ConfirmDialog';
import { useToast } from 'contexts/ToastContext';
import {
  listOpsRuns,
  listClientOpsSubscriptions,
  updateClientOpsSubscriptions,
  listClientOpsCredentials,
  validateOpsCredential,
  deleteOpsCredential,
  listOpsRunDefinitions
} from 'api/ops';

function fmt(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function ClientOpsView({ clientUserId, clientName, onOpenChat, onOpenRun }) {
  const { showToast } = useToast();
  const [runs, setRuns] = useState([]);
  const [subs, setSubs] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [creds, setCreds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [savingSubs, setSavingSubs] = useState(false);
  const [validatingId, setValidatingId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, s, c, d] = await Promise.all([
        listOpsRuns({ client_user_id: clientUserId, limit: 3 }),
        listClientOpsSubscriptions(clientUserId),
        listClientOpsCredentials(clientUserId),
        listOpsRunDefinitions()
      ]);
      setRuns(r);
      setSubs(s);
      setCreds(c);
      setDefinitions(d);
    } catch (err) {
      showToast(`Couldn't load client ops: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [clientUserId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const updateSub = (idx, patch) => {
    setSubs((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const saveSubs = async () => {
    setSavingSubs(true);
    try {
      const payload = subs.map((s) => ({
        run_definition_id: s.run_definition_id,
        enabled: Boolean(s.enabled),
        schedule_cron: s.schedule_cron || null,
        rotation_group: s.rotation_group ? parseInt(s.rotation_group, 10) : null,
        email_on_completion: Boolean(s.email_on_completion)
      }));
      const updated = await updateClientOpsSubscriptions(clientUserId, payload);
      setSubs((prev) =>
        prev.map((s) => {
          const fresh = updated.find((u) => u.run_definition_id === s.run_definition_id);
          return fresh ? { ...s, ...fresh } : s;
        })
      );
      showToast('Subscriptions saved', 'success');
    } catch (err) {
      showToast(`Save failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setSavingSubs(false);
    }
  };

  const validate = async (cred) => {
    setValidatingId(cred.id);
    try {
      // Phase 1 endpoint accepts {ok, error}; per-platform validators come later.
      // We pass ok=true here to record a successful manual ping.
      await validateOpsCredential(clientUserId, cred.id, { ok: true });
      showToast('Credential marked valid', 'success');
      load();
    } catch (err) {
      showToast(`Validate failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setValidatingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteOpsCredential(clientUserId, deleteTarget.id);
      showToast('Credential deleted', 'success');
      setDeleteTarget(null);
      load();
    } catch (err) {
      showToast(`Delete failed: ${err.response?.data?.message || err.message}`, 'error');
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h4">{clientName}</Typography>
        <Box sx={{ flex: 1 }} />
        <LoadingButton
          startIcon={<RefreshIcon />}
          variant="outlined"
          size="small"
          onClick={load}
          loading={loading}
          loadingLabel="Loading"
        >
          Refresh
        </LoadingButton>
        <Button
          startIcon={<ChatIcon />}
          variant="contained"
          size="small"
          onClick={() => onOpenChat?.(clientUserId)}
        >
          Open Chat
        </Button>
      </Stack>

      <MainCard title="Latest runs">
        {runs.length === 0 ? (
          <EmptyState title="No runs yet" message="Trigger one from the Runs tab." />
        ) : (
          <Stack spacing={1}>
            {runs.map((r) => (
              <Stack key={r.id} direction="row" spacing={1} alignItems="center">
                <StatusChip status={r.status} />
                <Typography variant="body2">{r.tier}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {fmt(r.started_at || r.created_at)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {r.cost_estimate_cents || 0}¢
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Button size="small" onClick={() => onOpenRun?.(r.id)}>
                  Open
                </Button>
              </Stack>
            ))}
          </Stack>
        )}
      </MainCard>

      <MainCard
        title="Subscriptions"
        secondary={
          <LoadingButton
            size="small"
            variant="contained"
            onClick={saveSubs}
            loading={savingSubs}
            loadingLabel="Saving"
            disabled={subs.length === 0}
          >
            Save
          </LoadingButton>
        }
      >
        {subs.length === 0 ? (
          <EmptyState
            title="No subscriptions yet"
            message="Run definitions matching this client's tier will be auto-created on next provisioning. For now you can edit existing rows here."
          />
        ) : (
          <Stack spacing={1.5}>
            {subs.map((s, idx) => {
              const def = definitions.find((d) => d.id === s.run_definition_id);
              return (
                <SubCard
                  key={s.run_definition_id}
                  title={def?.name || s.definition_name || s.run_definition_id?.slice(0, 8)}
                >
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
                    <Chip size="small" label={def?.tier || s.definition_tier || '—'} />
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Switch
                        size="small"
                        checked={Boolean(s.enabled)}
                        onChange={(e) => updateSub(idx, { enabled: e.target.checked })}
                      />
                      <Typography variant="caption">Enabled</Typography>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      Cadence: tier default ({def?.tier || s.definition_tier || '—'})
                    </Typography>
                    {/* Custom cron + rotation-group editing are coming once the
                        scheduler honors them — current backend ignores rotation
                        and silently drops cron-set subs from fanout. Persisted
                        values are preserved server-side via the PUT body. */}
                  </Stack>
                </SubCard>
              );
            })}
          </Stack>
        )}
      </MainCard>

      <MainCard title="Credentials health">
        {creds.length === 0 ? (
          <EmptyState
            title="No credentials stored"
            message="OAuth and API credentials show up here once provisioned."
          />
        ) : (
          <Stack spacing={1}>
            {creds.map((c) => {
              const validatedOk = c.last_validated_at && !c.last_validation_error;
              return (
                <Stack key={c.id} direction="row" spacing={1} alignItems="center">
                  <Chip size="small" label={c.platform} variant="outlined" />
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {c.account_id}
                  </Typography>
                  {validatedOk ? (
                    <StatusChip status="connected" label={`OK · ${fmt(c.last_validated_at)}`} />
                  ) : c.last_validation_error ? (
                    <StatusChip status="failed" label={c.last_validation_error.slice(0, 40)} />
                  ) : (
                    <StatusChip status="pending" label="Never validated" />
                  )}
                  <Box sx={{ flex: 1 }} />
                  <LoadingButton
                    size="small"
                    startIcon={<VerifiedIcon />}
                    onClick={() => validate(c)}
                    loading={validatingId === c.id}
                    loadingLabel="Validating"
                  >
                    Validate
                  </LoadingButton>
                  <Button
                    size="small"
                    color="error"
                    startIcon={<DeleteIcon />}
                    onClick={() => setDeleteTarget(c)}
                  >
                    Delete
                  </Button>
                </Stack>
              );
            })}
          </Stack>
        )}
      </MainCard>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete credential?"
        message={`Remove the ${deleteTarget?.platform} credential for ${clientName}? This can't be undone.`}
        confirmLabel="Delete"
        confirmColor="error"
      />
    </Stack>
  );
}
