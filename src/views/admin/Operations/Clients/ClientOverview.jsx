/**
 * ClientOverview — curated digest section for a single client.
 *
 * Shows: 4 stat tiles (open findings, posts scheduled, MTD spend, monthly cap),
 * top 5 notable findings (deep-links to Findings section), and scheduled-soon
 * content (blogs + social) in the next 48h.
 *
 * Read-only section — no toast needed.
 */

import { useEffect, useState } from 'react';
import { Box, Chip, Grid, List, ListItemButton, ListItemText, Stack, Typography } from '@mui/material';
import { getClientOverview } from 'api/ops';
import { useOpsWorkspace } from '../OpsWorkspaceContext';
import SubCard from 'ui-component/cards/SubCard';
import EmptyState from 'ui-component/extended/EmptyState';

// Severity strings ('critical', 'warning', 'info') are not in StatusChip's map,
// so we use a local color lookup and a plain MUI Chip.
const SEVERITY_COLOR = {
  critical: 'error',
  high: 'error',
  warning: 'warning',
  medium: 'warning',
  low: 'info',
  info: 'info'
};

function SeverityChip({ severity, size = 'small', sx }) {
  const color = SEVERITY_COLOR[(severity || '').toLowerCase()] || 'default';
  const label = severity ? severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase() : 'Unknown';
  return <Chip label={label} color={color} size={size} sx={sx} />;
}

function StatTile({ label, value }) {
  return (
    <Box
      sx={{
        height: '100%',
        p: 2.5,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        bgcolor: 'background.paper'
      }}
    >
      <Typography variant="h2" sx={{ fontWeight: 700, mb: 0.5 }}>
        {value}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}

function dollars(cents) {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ClientOverview({ clientUserId }) {
  const { setSection } = useOpsWorkspace();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getClientOverview(clientUserId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientUserId]);

  if (loading) {
    return (
      <Typography color="text.secondary" sx={{ p: 1 }}>
        Loading overview…
      </Typography>
    );
  }

  if (!data) {
    return <EmptyState title="No overview" message="Couldn't load this client's overview." />;
  }

  return (
    <Stack spacing={3}>
      {/* Stat tiles */}
      <Grid container spacing={2.5}>
        <Grid item xs={6} md={3}>
          <StatTile label="Open findings" value={data.counts.openFindings} />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatTile label="Posts scheduled" value={data.counts.postsScheduled} />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatTile label="MTD spend" value={dollars(data.counts.mtdSpendCents)} />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatTile label="Monthly cap" value={dollars(data.counts.capCents)} />
        </Grid>
      </Grid>

      {/* Notable findings */}
      <SubCard
        title="Notable findings"
        secondary={
          data.topFindings.length > 0 && (
            <Chip size="small" label="View all" onClick={() => setSection('findings')} sx={{ cursor: 'pointer' }} />
          )
        }
      >
        {data.topFindings.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nothing needs attention right now.
          </Typography>
        ) : (
          <List dense disablePadding>
            {data.topFindings.map((f) => (
              <ListItemButton key={f.id} onClick={() => setSection('findings')} sx={{ borderRadius: 1, px: 1 }}>
                <SeverityChip severity={f.severity} sx={{ mr: 1.5, flexShrink: 0 }} />
                <ListItemText primary={f.summary} secondary={f.category} primaryTypographyProps={{ noWrap: true }} />
              </ListItemButton>
            ))}
          </List>
        )}
      </SubCard>

      {/* Scheduled soon (next 48h) */}
      <SubCard title="Scheduled soon">
        {data.scheduledToday.blogs.length === 0 && data.scheduledToday.social.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No content scheduled in the next 48 hours.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {data.scheduledToday.blogs.map((b) => (
              <Box key={b.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Chip
                  size="small"
                  label="Blog"
                  color="primary"
                  variant="outlined"
                  onClick={() => setSection('blog')}
                  sx={{ cursor: 'pointer', flexShrink: 0 }}
                />
                <Typography variant="body2" noWrap>
                  {b.title}
                </Typography>
              </Box>
            ))}
            {data.scheduledToday.social.map((s) => (
              <Box key={s.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Chip
                  size="small"
                  label="Social"
                  color="secondary"
                  variant="outlined"
                  onClick={() => setSection('socials')}
                  sx={{ cursor: 'pointer', flexShrink: 0 }}
                />
                <Typography variant="body2" noWrap>
                  {(s.content || '').slice(0, 80)}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </SubCard>
    </Stack>
  );
}
