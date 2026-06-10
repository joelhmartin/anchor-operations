/**
 * DiscoveryDetail — drilldown for a single discovery (formerly "finding").
 *
 * Surfaces the full evidence + linked check_results plus the new state machine
 * (status, owner, business_impact). Generate Plan + Approve fix are wired
 * disabled here in Phase B; Phase D enables them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Button, Chip, Collapse, Divider, IconButton, Stack, TextField, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ShieldIcon from '@mui/icons-material/Shield';
import MainCard from 'ui-component/cards/MainCard';
import SubCard from 'ui-component/cards/SubCard';
import StatusChip from 'ui-component/extended/StatusChip';
import LoadingButton from 'ui-component/extended/LoadingButton';
import SelectField from 'ui-component/extended/SelectField';
import { useToast } from 'contexts/ToastContext';
import { listOpsFindings, listOpsCheckResults, updateOpsFinding, acknowledgeOpsFinding } from 'api/ops';

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'ignored', label: 'Ignored' }
];

function severityColor(sev) {
  return { critical: 'error', warning: 'warning', info: 'info' }[sev] || 'default';
}

function fmt(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function DiscoveryDetail({ discoveryId, onClose, onOpenRun }) {
  const { showToast } = useToast();
  const [discovery, setDiscovery] = useState(null);
  const [checkResults, setCheckResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [savingOwner, setSavingOwner] = useState(false);
  const [savingImpact, setSavingImpact] = useState(false);
  const [businessImpact, setBusinessImpact] = useState('');
  const [ownerInput, setOwnerInput] = useState('');
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const load = useCallback(async () => {
    if (!discoveryId) return;
    setLoading(true);
    try {
      // No GET /findings/:id endpoint yet — fetch via list with id-prefix client filter.
      const all = await listOpsFindings({});
      const match = (all || []).find((f) => f.id === discoveryId) || null;
      setDiscovery(match);
      setBusinessImpact(match?.business_impact || '');
      setOwnerInput(match?.owner_user_id || '');
      if (match?.run_id) {
        try {
          const results = await listOpsCheckResults(match.run_id);
          const linked = new Set(match.linked_check_result_ids || []);
          setCheckResults((results || []).filter((r) => linked.size === 0 || linked.has(r.id)));
        } catch {
          setCheckResults([]);
        }
      } else {
        setCheckResults([]);
      }
    } catch (err) {
      showToast(`Couldn't load discovery: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [discoveryId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (next) => {
    if (!discovery || next === discovery.status) return;
    setSavingStatus(true);
    try {
      const updated = await updateOpsFinding(discovery.id, { status: next });
      setDiscovery((prev) => ({ ...prev, ...updated }));
      showToast(`Status set to ${next}`, 'success');
    } catch (err) {
      showToast(`Status change failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setSavingStatus(false);
    }
  };

  const saveOwner = async () => {
    if (!discovery) return;
    setSavingOwner(true);
    try {
      const updated = await updateOpsFinding(discovery.id, {
        owner_user_id: ownerInput.trim() || null
      });
      setDiscovery((prev) => ({ ...prev, ...updated }));
      showToast('Owner saved', 'success');
    } catch (err) {
      showToast(`Owner save failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setSavingOwner(false);
    }
  };

  const saveBusinessImpact = async () => {
    if (!discovery) return;
    setSavingImpact(true);
    try {
      const updated = await updateOpsFinding(discovery.id, {
        business_impact: businessImpact.trim() || null
      });
      setDiscovery((prev) => ({ ...prev, ...updated }));
      showToast('Business impact saved', 'success');
    } catch (err) {
      showToast(`Save failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setSavingImpact(false);
    }
  };

  const ack = async () => {
    if (!discovery) return;
    try {
      const updated = await acknowledgeOpsFinding(discovery.id);
      setDiscovery((prev) => ({ ...prev, ...updated }));
      showToast('Acknowledged', 'success');
    } catch (err) {
      showToast(`Ack failed: ${err.response?.data?.message || err.message}`, 'error');
    }
  };

  const evidenceText = useMemo(() => {
    // Phase E populates evidence_pack_json (a compacted, citation-friendly
    // summary). Until then evidence_json carries the raw payload, so prefer
    // the pack and fall back so legacy and migrated rows both render.
    const source = discovery?.evidence_pack_json || discovery?.evidence_json || {};
    try {
      return JSON.stringify(source, null, 2);
    } catch {
      return '';
    }
  }, [discovery]);

  if (!discoveryId) return null;

  if (loading && !discovery) {
    return (
      <MainCard title="Discovery">
        <Typography color="text.secondary">Loading…</Typography>
      </MainCard>
    );
  }

  if (!discovery) {
    return (
      <MainCard
        title="Discovery"
        secondary={
          <IconButton onClick={onClose} size="small">
            <CloseIcon fontSize="small" />
          </IconButton>
        }
      >
        <Typography color="text.secondary">Not found.</Typography>
      </MainCard>
    );
  }

  return (
    <MainCard
      title="Discovery"
      secondary={
        <IconButton onClick={onClose} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      }
    >
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Chip size="small" label={discovery.severity || 'info'} color={severityColor(discovery.severity)} />
          <StatusChip status={discovery.status === 'investigating' ? 'in_progress' : 'pending'} label={discovery.status || 'open'} />
          {Array.isArray(discovery.affected_platforms) &&
            discovery.affected_platforms.map((p) => <Chip key={p} size="small" label={p} variant="outlined" />)}
          <Typography variant="caption" color="text.secondary">
            score {Number(discovery.attention_score || 0).toFixed(1)} · {fmt(discovery.created_at)}
          </Typography>
        </Stack>

        <Box>
          <Typography variant="h5">{discovery.summary || discovery.category}</Typography>
          {discovery.business_impact ? (
            <Typography variant="body2" color="text.secondary">
              {discovery.business_impact}
            </Typography>
          ) : null}
        </Box>

        <SubCard title="Recommended action">
          {discovery.recommended_action_json ? (
            <Box component="pre" sx={{ m: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(discovery.recommended_action_json, null, 2)}
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No recommended action recorded yet. Generate Plan ships in Phase D.
            </Typography>
          )}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" variant="outlined" startIcon={<AutoAwesomeIcon />} disabled title="Generate Plan ships in Phase D">
              Generate Plan
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<ShieldIcon />}
              disabled={!discovery.proposed_plan_json}
              title={discovery.proposed_plan_json ? 'Approve fix' : 'Generate a plan first'}
            >
              Approve fix
            </Button>
          </Stack>
        </SubCard>

        <SubCard title="State">
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Box sx={{ minWidth: 200 }}>
                <SelectField
                  label="Status"
                  value={discovery.status || 'open'}
                  onChange={(e) => setStatus(e.target.value)}
                  options={STATUS_OPTIONS}
                  size="small"
                  disabled={savingStatus}
                />
              </Box>
              {!discovery.acknowledged_at && (
                <Button size="small" onClick={ack}>
                  Acknowledge
                </Button>
              )}
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                label="Owner user id (UUID)"
                size="small"
                value={ownerInput}
                onChange={(e) => setOwnerInput(e.target.value)}
                sx={{ flex: 1 }}
              />
              <LoadingButton size="small" variant="outlined" onClick={saveOwner} loading={savingOwner} loadingLabel="Saving">
                Save owner
              </LoadingButton>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="flex-start">
              <TextField
                label="Business impact"
                size="small"
                value={businessImpact}
                onChange={(e) => setBusinessImpact(e.target.value)}
                multiline
                minRows={2}
                sx={{ flex: 1 }}
              />
              <LoadingButton size="small" variant="outlined" onClick={saveBusinessImpact} loading={savingImpact} loadingLabel="Saving">
                Save
              </LoadingButton>
            </Stack>
          </Stack>
        </SubCard>

        <SubCard
          title={
            <Stack direction="row" alignItems="center" spacing={0.5} onClick={() => setEvidenceOpen((v) => !v)} sx={{ cursor: 'pointer' }}>
              {evidenceOpen ? <ExpandMoreIcon /> : <ChevronRightIcon />}
              <span>Evidence</span>
            </Stack>
          }
        >
          <Collapse in={evidenceOpen}>
            <Box
              component="pre"
              sx={{
                m: 0,
                fontSize: 11,
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                maxHeight: 400,
                overflow: 'auto'
              }}
            >
              {evidenceText}
            </Box>
          </Collapse>
        </SubCard>

        {discovery.run_id ? (
          <SubCard
            title={
              <Stack direction="row" alignItems="center" spacing={1}>
                <span>Linked run</span>
                <Button size="small" onClick={() => onOpenRun?.(discovery.run_id)}>
                  Open run
                </Button>
              </Stack>
            }
          >
            {checkResults.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No linked check results.
              </Typography>
            ) : (
              <Stack spacing={0.5} divider={<Divider />}>
                {checkResults.map((r) => (
                  <Stack key={r.id} direction="row" spacing={1} alignItems="center">
                    <Chip size="small" label={r.status} variant="outlined" />
                    <Typography variant="body2">{r.check_id}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {r.umbrella}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}
          </SubCard>
        ) : null}
      </Stack>
    </MainCard>
  );
}
