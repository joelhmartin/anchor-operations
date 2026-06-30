/**
 * AccessAuditTab — Operations > Portfolio > Access Audit (north-star §0.3 / §19.3).
 *
 * Renders the latest persisted access-audit run as a green/yellow/red board and
 * lets an admin re-run it. Two sections:
 *   • System — runtime/env, database, Pub/Sub, and agency credential presence.
 *   • Client access coverage — how many real clients have each platform connected.
 *
 * Backed by GET /api/ops/access/audit and POST /api/ops/access/audit/run.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Box, Card, CardContent, Typography, Button, Chip, Stack, Grid,
  LinearProgress, CircularProgress, Alert, Tooltip
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ChatIcon from '@mui/icons-material/ChatBubbleOutline';
import { getAccessAudit, runAccessAudit, notifyAccessAudit } from '../../../../api/ops';

const COLOR = { green: 'success', yellow: 'warning', red: 'error', gray: 'default' };

// Normalize either the persisted row (details_json/summary_json) or the live
// run view (details/summary).
function readAudit(a) {
  if (!a) return null;
  const details = a.details || a.details_json || {};
  const summary = a.summary || a.summary_json || {};
  return {
    status: a.status,
    environment: a.environment || details.runtime?.environment || 'unknown',
    createdAt: a.finished_at || a.created_at || null,
    runtime: details.runtime || {},
    services: details.services || {},
    coverage: details.clientCoverage || { total: 0, services: {} },
    summary
  };
}

const labelize = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function StatusChip({ status, color }) {
  return <Chip size="small" label={status || 'unknown'} color={COLOR[color] || COLOR[status] || 'default'} />;
}

function ServiceCard({ name, svc }) {
  const detail =
    svc.detail ||
    (svc.missing?.length ? `missing: ${svc.missing.join(', ')}` : '') ||
    (svc.present?.length ? `present: ${svc.present.join(', ')}` : '') ||
    (svc.tables ? `${svc.tables.present?.length || 0} tables present` : '');
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent sx={{ py: 1.5 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="subtitle2">{labelize(name)}</Typography>
          <StatusChip status={svc.status} color={svc.color} />
        </Stack>
        {detail ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {detail}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CoverageRow({ name, svc }) {
  const pct = svc.total ? Math.round((svc.connected / svc.total) * 100) : 0;
  return (
    <Box sx={{ mb: 1.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.25 }}>
        <Typography variant="body2">{labelize(name)}</Typography>
        <Tooltip title={svc.detail || ''}>
          <Typography variant="caption" color="text.secondary">
            {svc.connected}/{svc.total} ({pct}%)
          </Typography>
        </Tooltip>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={pct}
        color={COLOR[svc.status] === 'default' ? 'inherit' : COLOR[svc.status] || 'primary'}
        sx={{ height: 8, borderRadius: 1 }}
      />
    </Box>
  );
}

export default function AccessAuditTab() {
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAudit(readAudit(await getAccessAudit()));
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to load audit');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      setAudit(readAudit(await runAccessAudit()));
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || 'Audit run failed');
    } finally {
      setRunning(false);
    }
  };

  const notify = async () => {
    setNotifying(true);
    setError(null);
    setNotice(null);
    try {
      const r = await notifyAccessAudit();
      if (r?.ok) setNotice('Posted the audit summary to Google Chat.');
      else if (r?.reason === 'no_webhook_configured') setError('No Google Chat webhook is configured on the server.');
      else if (r?.reason === 'no_audit_yet') setError('Run the audit first, then post it.');
      else setError(`Could not post to Chat (${r?.reason || 'unknown'}).`);
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || 'Posting to Chat failed');
    } finally {
      setNotifying(false);
    }
  };

  if (loading) return <Box sx={{ py: 6, textAlign: 'center' }}><CircularProgress /></Box>;

  const sum = audit?.summary || {};
  const coverage = audit?.coverage || { total: 0, services: {} };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h6">Access Audit</Typography>
          <Typography variant="caption" color="text.secondary">
            {audit
              ? `Environment: ${audit.environment}${audit.createdAt ? ` · last run ${new Date(audit.createdAt).toLocaleString()}` : ''}`
              : 'No audit has been run yet.'}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={notifying ? <CircularProgress size={16} color="inherit" /> : <ChatIcon />} onClick={notify} disabled={notifying || !audit}>
            {notifying ? 'Posting…' : 'Send to Google Chat'}
          </Button>
          <Button variant="contained" startIcon={running ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />} onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run audit now'}
          </Button>
        </Stack>
      </Stack>

      {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}

      {audit ? (
        <>
          <Stack direction="row" spacing={1} sx={{ mb: 3 }}>
            <Chip label={`Overall: ${audit.status}`} color={audit.status === 'verified' ? 'success' : audit.status === 'failed' ? 'error' : 'warning'} />
            {['green', 'yellow', 'red', 'gray'].map((c) =>
              sum[c] ? <Chip key={c} size="small" variant="outlined" color={COLOR[c]} label={`${sum[c]} ${c}`} /> : null
            )}
          </Stack>

          <Typography variant="overline" color="text.secondary">Client access coverage ({coverage.total} clients)</Typography>
          <Card variant="outlined" sx={{ mb: 3, mt: 0.5 }}>
            <CardContent>
              {Object.keys(coverage.services).length ? (
                Object.entries(coverage.services).map(([name, svc]) => <CoverageRow key={name} name={name} svc={svc} />)
              ) : (
                <Typography variant="body2" color="text.secondary">No client coverage data.</Typography>
              )}
            </CardContent>
          </Card>

          <Typography variant="overline" color="text.secondary">System & credentials</Typography>
          <Grid container spacing={1.5} sx={{ mt: 0.25 }}>
            {Object.entries(audit.services).map(([name, svc]) => (
              <Grid item xs={12} sm={6} md={4} key={name}>
                <ServiceCard name={name} svc={svc} />
              </Grid>
            ))}
          </Grid>
        </>
      ) : (
        <Alert severity="info">Click “Run audit now” to check what’s connected.</Alert>
      )}
    </Box>
  );
}
