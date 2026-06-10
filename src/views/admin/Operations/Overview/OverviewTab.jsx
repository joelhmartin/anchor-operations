/**
 * OverviewTab — Phase 9 Operations command-center entry point.
 *
 * Portfolio KPI strip + 7-day trend (pure SVG, no chart deps).
 * Backed by GET /api/ops/overview which aggregates ops_runs + ops_findings.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Grid, Stack, Typography, useTheme } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import MainCard from 'ui-component/cards/MainCard';
import LoadingButton from 'ui-component/extended/LoadingButton';
import EmptyState from 'ui-component/extended/EmptyState';
import { useToast } from 'contexts/ToastContext';
import { getOpsOverview } from 'api/ops';

function KpiCard({ label, value, hint, accent }) {
  return (
    <MainCard contentSX={{ p: 2 }}>
      <Stack spacing={0.5}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h3" sx={{ color: accent || 'text.primary' }}>
          {value}
        </Typography>
        {hint && (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        )}
      </Stack>
    </MainCard>
  );
}

function dollars(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

function TrendChart({ rows }) {
  const theme = useTheme();
  if (!rows || rows.length === 0) {
    return <EmptyState title="No activity in the last 7 days" message="Trigger a run to populate the trend." />;
  }

  const width = 720;
  const height = 200;
  const pad = 32;

  const days = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(cursor);
    d.setDate(cursor.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const match = rows.find((r) => String(r.day).slice(0, 10) === iso);
    days.push({
      day: iso,
      run_count: match?.run_count || 0,
      critical: match?.critical || 0,
      warning: match?.warning || 0,
      info: match?.info || 0
    });
  }

  const maxRun = Math.max(...days.map((d) => d.run_count), 1);
  const maxFind = Math.max(...days.map((d) => d.critical + d.warning + d.info), 1);
  const stepX = (width - pad * 2) / (days.length - 1 || 1);

  const yRun = (v) => height - pad - (v / maxRun) * (height - pad * 2);
  const yFind = (v) => height - pad - (v / maxFind) * (height - pad * 2);

  const runPath = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${pad + i * stepX},${yRun(d.run_count)}`).join(' ');
  const critPath = days
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${pad + i * stepX},${yFind(d.critical)}`)
    .join(' ');

  return (
    <Box sx={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="auto" role="img" aria-label="7-day ops trend">
        <line
          x1={pad}
          y1={height - pad}
          x2={width - pad}
          y2={height - pad}
          stroke={theme.palette.divider}
          strokeWidth="1"
        />
        <path d={runPath} fill="none" stroke={theme.palette.primary.main} strokeWidth="2" />
        <path d={critPath} fill="none" stroke={theme.palette.error.main} strokeWidth="2" strokeDasharray="4 3" />
        {days.map((d, i) => (
          <g key={d.day}>
            <circle cx={pad + i * stepX} cy={yRun(d.run_count)} r="3" fill={theme.palette.primary.main} />
            <circle cx={pad + i * stepX} cy={yFind(d.critical)} r="3" fill={theme.palette.error.main} />
            <text
              x={pad + i * stepX}
              y={height - pad + 16}
              fontSize="10"
              fill={theme.palette.text.secondary}
              textAnchor="middle"
            >
              {d.day.slice(5)}
            </text>
          </g>
        ))}
      </svg>
      <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
        <Typography variant="caption" sx={{ color: theme.palette.primary.main }}>
          ━ runs / day
        </Typography>
        <Typography variant="caption" sx={{ color: theme.palette.error.main }}>
          ╌ critical findings
        </Typography>
      </Stack>
    </Box>
  );
}

export default function OverviewTab() {
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getOpsOverview();
      setData(res);
    } catch (err) {
      showToast(`Couldn't load overview: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const cards = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Runs (7d)', value: data.runs_last_7d ?? 0 },
      {
        label: 'Critical findings open',
        value: data.critical_findings_open ?? 0,
        accent: (data.critical_findings_open ?? 0) > 0 ? 'error.main' : undefined
      },
      {
        label: 'Throttled by budget (MTD)',
        value: data.runs_throttled_mtd ?? 0,
        accent: (data.runs_throttled_mtd ?? 0) > 0 ? 'warning.main' : undefined
      },
      { label: 'Active subscribed clients', value: data.active_subscribed_clients ?? 0 },
      { label: 'MTD spend', value: dollars(data.mtd_cost_cents), hint: 'Across all runs this month' }
    ];
  }, [data]);

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center">
        <Typography variant="h4">Portfolio Overview</Typography>
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
      </Stack>

      <Grid container spacing={2}>
        {cards.map((c) => (
          <Grid key={c.label} item xs={12} sm={6} md={4} lg={2.4}>
            <KpiCard label={c.label} value={c.value} hint={c.hint} accent={c.accent} />
          </Grid>
        ))}
      </Grid>

      <MainCard title="7-day trend">
        <TrendChart rows={data?.trend || []} />
      </MainCard>
    </Stack>
  );
}
