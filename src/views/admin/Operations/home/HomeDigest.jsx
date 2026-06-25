/**
 * HomeDigest — curated home view for the Operations workspace.
 *
 * Three sections:
 *   1. Needs Attention  — clients with critical findings (deep-links to Findings)
 *   2. Scheduled Today  — blog posts + social posts publishing today (deep-links to Blog/Socials)
 *   3. Approvals Waiting — count of pending AI tool approvals (prompt to open Chat)
 */

import { useEffect, useState } from 'react';
import { Typography, Stack, List, ListItemButton, ListItemText, Chip, Box } from '@mui/material';
import { getOpsHome } from 'api/ops';
import { useOpsWorkspace } from '../OpsWorkspaceContext';
import { clientLabel } from '../_clientLabel';
import SubCard from 'ui-component/cards/SubCard';
import EmptyState from 'ui-component/extended/EmptyState';

export default function HomeDigest() {
  const { clients, openClientSection } = useOpsWorkspace();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getOpsHome()
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
  }, []);

  const labelFor = (id) => clientLabel(clients.find((c) => c.id === id));
  const openClient = openClientSection;

  if (loading) return <Typography color="text.secondary">Loading…</Typography>;
  if (!data) return <EmptyState title="No data" message="Couldn't load the home digest." />;

  return (
    <Stack spacing={3}>
      {/* Needs Attention */}
      <SubCard title="Needs attention">
        {data.needsAttention.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            All clear — no critical findings.
          </Typography>
        ) : (
          <List dense disablePadding>
            {data.needsAttention.map((n) => (
              <ListItemButton
                key={n.clientUserId}
                onClick={() => openClient(n.clientUserId, 'findings')}
                sx={{ borderRadius: 1, px: 1 }}
              >
                <Chip size="small" color="error" label={n.criticalCount} sx={{ mr: 1.5, minWidth: 32 }} />
                <ListItemText
                  primary={labelFor(n.clientUserId)}
                  secondary={n.top}
                  primaryTypographyProps={{ variant: 'body2', fontWeight: 600 }}
                  secondaryTypographyProps={{ variant: 'caption', noWrap: true }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </SubCard>

      {/* Scheduled Today */}
      <SubCard title="Scheduled today">
        {data.scheduledToday.blogs.length === 0 && data.scheduledToday.social.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nothing scheduled to publish today.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {data.scheduledToday.blogs.map((b) => (
              <Box key={b.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <Chip size="small" label="Blog" color="primary" variant="outlined" sx={{ flexShrink: 0 }} />
                <Typography
                  variant="body2"
                  sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {labelFor(b.client_id)} — {b.title}
                </Typography>
                <Chip size="small" label="Review" onClick={() => openClient(b.client_id, 'blog')} clickable />
              </Box>
            ))}
            {data.scheduledToday.social.map((s) => (
              <Box key={s.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <Chip size="small" label="Social" color="secondary" variant="outlined" sx={{ flexShrink: 0 }} />
                <Typography
                  variant="body2"
                  sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {labelFor(s.client_id)} — {(s.content || '').slice(0, 60)}
                </Typography>
                <Chip size="small" label="Review" onClick={() => openClient(s.client_id, 'socials')} clickable />
              </Box>
            ))}
          </Stack>
        )}
      </SubCard>

      {/* Approvals Waiting */}
      <SubCard
        title="Approvals waiting"
        secondary={
          <Chip size="small" color={data.approvalsWaiting > 0 ? 'warning' : 'default'} label={data.approvalsWaiting} />
        }
      >
        <Typography variant="body2" color="text.secondary">
          Pending AI tool approvals across all clients. Open a client&apos;s Chat to review.
        </Typography>
      </SubCard>
    </Stack>
  );
}
