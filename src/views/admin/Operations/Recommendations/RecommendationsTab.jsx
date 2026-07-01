/**
 * RecommendationsTab — the "Action Queue".
 *
 * Surfaces the recommendations the ops engine derives from a client's open
 * findings. Admins can generate the queue, then approve/acknowledge or reject
 * each recommendation. Read-through to `/api/ops` recommendation routes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Button, Card, CardContent, Chip, Divider, Stack, TextField, Tooltip, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import EmptyState from 'ui-component/extended/EmptyState';
import LoadingButton from 'ui-component/extended/LoadingButton';
import FormDialog from 'ui-component/extended/FormDialog';
import { useToast } from 'contexts/ToastContext';
import { listRecommendations, buildRecommendations, approveRecommendation, rejectRecommendation } from 'api/ops';

const RISK_COLORS = { low: 'default', medium: 'info', high: 'warning', critical: 'error' };

const STATUS_COLORS = {
  proposed: 'info',
  approved: 'success',
  auto: 'success',
  executing: 'warning',
  executed: 'success',
  failed: 'error',
  rejected: 'default',
  blocked: 'error',
  superseded: 'default'
};

const APPROVAL_LABELS = {
  none: 'Advisory',
  approval_required: 'Approval required',
  admin_required: 'Admin required',
  blocked: 'Blocked'
};

function titleCase(value) {
  if (!value) return '';
  return String(value)
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function RecommendationCard({ rec, onApprove, onReject, busy }) {
  const isAdvisory = rec.approval_level === 'none';
  const actionable = rec.status === 'proposed';
  const findingCount = Array.isArray(rec.finding_ids) ? rec.finding_ids.length : 0;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap">
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h5" sx={{ mb: 0.5 }}>
              {rec.title || titleCase(rec.abstract_action_type) || 'Recommendation'}
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
              {rec.category && <Chip size="small" variant="outlined" label={rec.category} />}
              <Chip
                size="small"
                color={RISK_COLORS[rec.risk_tier] || 'default'}
                label={`Risk: ${titleCase(rec.risk_tier) || 'Unknown'}`}
              />
              <Chip size="small" color={STATUS_COLORS[rec.status] || 'default'} label={titleCase(rec.status)} />
              <Chip size="small" variant="outlined" label={APPROVAL_LABELS[rec.approval_level] || rec.approval_level || 'Unknown'} />
              {rec.destructive && <Chip size="small" color="error" variant="outlined" label="Destructive" />}
            </Stack>
          </Box>
        </Stack>

        {rec.summary && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            {rec.summary}
          </Typography>
        )}
        {rec.rationale && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            <Box component="span" sx={{ fontWeight: 600 }}>
              Rationale:{' '}
            </Box>
            {rec.rationale}
          </Typography>
        )}

        <Divider sx={{ my: 1.5 }} />

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="caption" color="text.secondary">
            {findingCount} linked finding{findingCount === 1 ? '' : 's'}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {actionable && (
            <>
              <Button
                size="small"
                color="error"
                startIcon={<CloseIcon />}
                disabled={busy}
                onClick={() => onReject(rec)}
              >
                Reject
              </Button>
              <LoadingButton
                size="small"
                variant="contained"
                color="success"
                startIcon={<CheckIcon />}
                loading={busy}
                onClick={() => onApprove(rec)}
              >
                {isAdvisory ? 'Acknowledge' : 'Approve'}
              </LoadingButton>
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

export default function RecommendationsTab({ activeClientId }) {
  const { showToast } = useToast();
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [building, setBuilding] = useState(false);
  const [actioningId, setActioningId] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!activeClientId) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await listRecommendations(activeClientId);
      setRecommendations(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err.response?.data?.detail || err.response?.data?.message || err.message);
    } finally {
      setLoading(false);
    }
  }, [activeClientId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleBuild = async () => {
    if (!activeClientId) return;
    setBuilding(true);
    try {
      await buildRecommendations(activeClientId);
      showToast('Recommendations generated from open findings', 'success');
      await load();
    } catch (err) {
      showToast(`Build failed: ${err.response?.data?.detail || err.response?.data?.message || err.message}`, 'error');
    } finally {
      setBuilding(false);
    }
  };

  const handleApprove = async (rec) => {
    setActioningId(rec.id);
    try {
      await approveRecommendation(rec.id);
      showToast(rec.approval_level === 'none' ? 'Recommendation acknowledged' : 'Recommendation approved', 'success');
      await load();
    } catch (err) {
      showToast(`Approve failed: ${err.response?.data?.detail || err.response?.data?.message || err.message}`, 'error');
    } finally {
      setActioningId(null);
    }
  };

  const submitReject = async () => {
    if (!rejectTarget) return;
    setRejectSubmitting(true);
    try {
      await rejectRecommendation(rejectTarget.id, rejectReason || null);
      showToast('Recommendation rejected', 'success');
      setRejectTarget(null);
      setRejectReason('');
      await load();
    } catch (err) {
      showToast(`Reject failed: ${err.response?.data?.detail || err.response?.data?.message || err.message}`, 'error');
    } finally {
      setRejectSubmitting(false);
    }
  };

  const sorted = useMemo(
    () => [...recommendations].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    [recommendations]
  );

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Tooltip title="Generate recommendations from this client's current open findings">
          <span>
            <LoadingButton
              variant="contained"
              startIcon={<AutoAwesomeIcon />}
              loading={building}
              loadingLabel="Building"
              onClick={handleBuild}
              disabled={!activeClientId}
            >
              Build recommendations
            </LoadingButton>
          </span>
        </Tooltip>
        <LoadingButton startIcon={<RefreshIcon />} onClick={load} loading={loading} loadingLabel="Loading" variant="outlined">
          Refresh
        </LoadingButton>
      </Stack>

      {error ? (
        <EmptyState
          title="Couldn't load recommendations"
          message={error}
          action={
            <Button variant="outlined" onClick={load}>
              Try again
            </Button>
          }
        />
      ) : loading && sorted.length === 0 ? (
        <EmptyState title="Loading recommendations…" />
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No recommendations yet"
          message="They're generated from open findings. Click Build to generate."
        />
      ) : (
        <Stack spacing={2}>
          {sorted.map((rec) => (
            <RecommendationCard
              key={rec.id}
              rec={rec}
              busy={actioningId === rec.id}
              onApprove={handleApprove}
              onReject={(r) => {
                setRejectTarget(r);
                setRejectReason('');
              }}
            />
          ))}
        </Stack>
      )}

      <FormDialog
        open={Boolean(rejectTarget)}
        onClose={() => setRejectTarget(null)}
        onSubmit={submitReject}
        title="Reject recommendation"
        loading={rejectSubmitting}
        submitLabel="Reject"
        submitColor="error"
      >
        <TextField
          label="Reason (optional)"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          multiline
          minRows={3}
          fullWidth
          autoFocus
        />
      </FormDialog>
    </Stack>
  );
}
